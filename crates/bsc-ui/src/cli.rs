//! The `bsc ui` subcommand — the ONE UI-design-surface command (#2469). Three verb families under a
//! single mount, so a restricted design session is expressible as one allow rule (`Bash(bsc ui *)`):
//!
//! - the **contract** verbs (#1852, owned here, over the embedded primitive contract
//!   `crate::CONTRACT_JSON`): `schema` (print the contract — every kind, its fields + enums),
//!   `validate [file]` (check a spec, a file else stdin, against it), and
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
    "the UI design surface — the primitive contract + themes (#1852) and the component library (#2469)";

/// The contract verbs bsc-ui owns. The component-library verbs are appended from
/// [`bsc_component::cli::command_docs`] by [`merged_commands`].
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "schema",
        summary: "print the primitive contract (every component, its props + enums)",
        usage: "\
USAGE:
  bsc ui schema [--name <Primitive>] [--pretty]

Prints the PRIMITIVE contract — every component of the shared kit, the props it accepts, which are
required, their types, and the closed value sets for enum props. This is the contract an AI authors UI
against: emit a tree of `{ type, props, children, binds, actions }` nodes and the desktop KitRenderer
renders it through the shared kit. It is the same contract `bsc ui validate` enforces.

  props     plain data — a literal for a declared prop.
  binds     a prop READ from host state: { \"on\": \"someStateKey\" }.
  actions   a prop that is a host CALLBACK, named: { \"onClick\": \"doTheThing\" }. A data tree never
            carries a function, so naming the host's action is the only way to wire behaviour.

--name narrows to one primitive (the whole kit is large). Compact JSON by default; --pretty indents.",
    },
    CmdDoc {
        name: "validate",
        summary: "validate a UI spec (file or stdin) against the primitive contract",
        usage: "\
USAGE:
  bsc ui validate <file>     # a UI spec JSON file
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
  bsc ui release add <id> <version> --from-store <kit>   # assemble the artifact from the live kit in the component store
  bsc ui release remove <id@version>             # delete a materialized entry (packaged stays embedded)
  bsc ui release verify <id@version>             # recompute the artifact hash against the manifest

The versioned released-kit store at ~/.base-studio-code/kits/<id>/<version>/ (--dir/
BSC_UI_KIT_STORE_DIR override): one immutable copy per id@version — `{ id, version, sha256, kind,
source? }` manifest + the artifact — shared by every blueprint that pins it. (Distinct from the
mutable working kits of `bsc ui kit`, #2281/#2469: a RELEASE is a frozen published snapshot.) `add`
reads the artifact from stdin (or --file), verifies --sha256 BEFORE writing (mismatch ⇒ nothing
stored), and refuses to overwrite an existing version with different content (bump the version
instead). It also REFUSES a hollow release (#3167): an empty artifact, or a component-kit that
doesn't parse / carries zero components, is rejected with a non-zero error BEFORE anything is stored.
--from-store <kit> assembles the artifact in one shot from the live kit in the component store
(instead of hand-piping --file): it reads the kit record + every component whose kitId is <kit> and
builds the same { id, version, kit, components } shape. The packaged `bsc/react-ui` kit resolves as a
built-in entry with zero setup.",
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
spec's structure. Every theme MUST declare its DESIGN GROUP via a `tech` slug (#2749 — the same axis
a kit carries: react, vue, …): the binding is mandatory and 1:1 from the theme's side, so `set` and
`validate` REJECT a theme with no `tech`. This is the SDK's THEME axis (style × theme × spec); the same collection the desktop
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
The report names the theme's `group` — its design-group binding (#2749) — so the diagnostic states
which group's contract it resolved against. Compact JSON by default; --pretty indents.",
    },
    CmdDoc {
        name: "tests",
        summary: "the per-node TEST manifest — harvest each component's colocated test file onto its node (#3907)",
        usage: "USAGE:
  bsc ui tests harvest [<root>] [--kit K] [--pretty]

Pairs each record with its COLOCATED test (`<src-without-ext>.test.tsx`, else `.test.ts`) under <root>
(default `.`) and prints the records that HAVE one, with `tests` populated. READ-ONLY — pipe into `set`:

  bsc ui tests harvest --kit base-studio-code | bsc ui set --by tests-harvest

MIRROR, not source: the files stay authoritative; this copies them onto the node so the graph is
queryable and `bsc ui doctor`'s `no-tests` is honest. ONE ENTRY PER FILE, verbatim — a test's meaning
lives partly outside its `it()` blocks (imports, beforeEach, mocks), so a per-test split would drop it.
A record with no colocated test is OMITTED, never given an empty `tests`.",
    },
    CmdDoc {
        name: "harvest",
        summary: "scan a repo and surface reusable COMPONENT candidates for the library (#3471)",
        usage: "USAGE:
  bsc ui harvest <repo-dir-or-file> [--kit K] [--worthy-only] [--out <name>] [--pretty]

The target is a directory (scan the tree) OR a single FILE (#3722 — scope to one component's module).
Parses the repo's real .tsx/.ts/.jsx/.js source with tree-sitter and lifts each React component into a
CANDIDATE component record — the component half of `bsc graph harvest`, so a project that gets BUILT fills
the component graph instead of the library being hand-authored one `bsc ui set` at a time. Deterministic
and zero-egress: parsing is local, and the walk is sorted so the output is order-stable. READ-ONLY — it
emits candidates, never stores them; promoting one is the curation gate's job.

A component is a PascalCase-named function that renders JSX — a `function`, an arrow, or one WRAPPED in a
higher-order call (`memo`/`forwardRef`/`observer`). Vendored/build/VCS dirs, test/story files, and NESTED
git roots (worktrees/submodules, whose src duplicates the primary tree) are skipped.

Not sure WHICH dir to harvest? A confined session's cwd is its own workspace, not the repo — run
`bsc ui env` to see the roots you may harvest (e.g. the app's own source tree), then harvest one of those.

Unlike the algorithms harvest, a candidate's `srcText` is a CLOSURE, not a node slice: the component plus
the same-file declarations it transitively references plus exactly the imports those need — because a
component's stored source must be a module the preview can COMPILE. Every candidate carries an honest
`buildable` with `unbuildableReasons`; one that could not be closed is emitted FLAGGED rather than
quietly degraded (a srcText with unresolved `@/…` imports otherwise stores with no complaint at all,
#3470). `composes` lists component NAMES (the component graph composes by name, not by id).

Prints { candidates: [...], count }, plus (#3740) `functionalModules` + a `note` when the tree also holds
functional/algorithmic modules (functions, hooks, utils) that are NOT components — those belong in the
ALGORITHMS graph, so harvest them with `bsc graph harvest <dir-or-file>` instead (this surfaces + routes
them so they aren't lost between the two harvests). A module NEITHER harvest lifts — a const/type module
such as a `STATUS_META` table, which is not a component and not a function — is read with `bsc files read
<path>` (#4161); the note says so when a target yields nothing. --kit sets the kit candidates would join (default `harvested`
— NOT an existing kit, since unreviewed candidates must not contaminate a curated one). --worthy-only keeps
those the classifier scores net-positive. --out <name> (#3722) writes the JSON to a BARE-named file in
$BSC_SCRATCH instead of stdout, then prints that path — use it when a large harvest would be truncated on
stdout (and spilled OUT of the confinement, unreadable); the scratch file is Read-able in full.",
    },
    CmdDoc {
        name: "env",
        summary: "show this session's scratch dir, write scopes, and the roots it may harvest (#3571)",
        usage: "USAGE:
  bsc ui env [--json]

Prints the session-scoped environment a confined studio session runs under — its scratch dir
($BSC_SCRATCH), its write scopes ($BSC_SCOPES), its FS-confinement root ($BSC_REPO_ROOT), and the READ-only
HARVEST roots it may scan ($BSC_HARVEST_ROOTS, e.g. the app's own source tree granted to the designer).

WHY: a restricted session is cwd'd in its own sealed workspace, NOT the repo, so it cannot otherwise
discover WHERE the app's UI lives on disk. Run this, read the harvest roots, then `bsc ui harvest <root>`
to mine that tree's components. READ-ONLY. --json emits the same as a machine-readable object.",
    },
    CmdDoc {
        name: "emit",
        summary: "vendor a component (or the whole kit) as compilable source into a directory (#2800)",
        usage: "\
USAGE:
  bsc ui emit component <id> <dir>   # a component + its transitive composes + the _kit runtime it needs
  bsc ui emit kit <dir>              # the whole kit
  bsc ui emit sync <dir>             # re-emit MANAGED files whose kit source moved; warn on hand-edited

Writes REAL, compilable source into <dir> (mirroring the src/ layout), every first-party `@/…` import
rewritten to a resolvable relative path — so the emitted tree builds with NO alias config and NO network.
`component` resolves against the WHOLE component store (#3720) when it's reachable — so ANY kit's
component emits (react-d3, harvested, …), not just react-ui — overlaid on the packaged artifact (which
supplies the react-ui sources + the shared runtime closure); when the store isn't mounted (the sealed
sandbox) it falls back to the packaged `bsc/react-ui` artifact, so react-ui still emits offline. (`kit`
and `sync` remain packaged-react-ui only.) Each file is provenance-stamped (`// vendored from <kit>@<ver>
(sha256:…)`), the fingerprint `sync` keys on. `component`/`kit` print { emitted, dir, files, externalDeps }
— `externalDeps` lists the npm packages (react, d3-*) the vendored code imports and the app must declare
(the closure vendors first-party source only).

`sync` is the ADOPT step (the atomic-upgrade model — re-run the command, don't hand-edit): it re-emits
every MANAGED file (unchanged since it was emitted — its body still matches the stamp's sha256) from
the current kit, and WARNS + skips every DIVERGED (hand-edited) file rather than clobbering it. Prints
{ dir, synced, upToDate, diverged, unknown }.",
    },
    CmdDoc {
        name: "changes",
        summary: "the RUNNING app's pending kit-change confirmations, read-only (#2951)",
        usage: "\
USAGE:
  bsc ui changes list [--json] [--pretty]   # kit changes awaiting the user's Approve, read-only

Lists the kit-change confirmations the RUNNING app has queued — a component's contract changed and the
designer's edit fans out to consumer projects, but the user hasn't Approved it yet in the top-right
banner. Read from the app's persisted state (`app-state.json`, like `bsc ui theme active`). One entry
per change: `{ change, consumers }` — its class (breaking/additive/fix), component, and summary, plus
the consumer project keys it propagates to. READ-ONLY: confirming is the app's action; bsc never writes
app-state while the app runs. `--json` emits the array (`--pretty` indents); empty when nothing is
pending (or the app isn't running).",
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
        Some("emit") => cmd_emit(&args[1..], prog),
        Some("harvest") => cmd_harvest(&args[1..]),
        Some("tests") => crate::tests_harvest::run(&args[1..], prog),
        Some("env") => cmd_env(&args[1..]),
        Some("changes") => cmd_changes(&args[1..]),
        // A KNOWN component-library verb (list/get/set/remove · kit · eslint-preset · usage) falls
        // through to the mounted store CLI, keeping this prog for its help/errors. Unknown verbs stay
        // ours so the error shows the MERGED overview, not the component-only one.
        // `regroup` is the DEPRECATED alias of `refolder` (#4107 slice B). It is deliberately absent
        // from `command_docs()` — help must advertise one name — so it is matched here explicitly;
        // otherwise this gate rejects it before the component dispatcher ever sees it.
        Some(v) if v == "regroup" || bsc_component::cli::command_docs().iter().any(|c| c.name == v) => {
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
        // #4152: through the shared emitter so a warm serve loop CAPTURES this into its response rather
        // than leaking it onto the protocol stream. Identical to `println!` when nothing is capturing.
        // These local closures bypassed `print_json`, which is what the byte-comparison against a
        // one-shot run caught — the response came back empty while the payload appeared as a stray line.
        bsc_util::emit_line(&s.map_err(|e| e.to_string())?);
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
    // The theme's DESIGN GROUP (#2749) — surfaced in the report so the diagnostic names which group's
    // contract the theme is resolved against. Per-group *contracts* are #2606; today one shared
    // contract backs every group, so resolution is unchanged — the binding is now explicit in output.
    let group = theme.get("tech").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
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
        "group": group,
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

/// `bsc ui emit component <id> <dir>` / `bsc ui emit kit <dir>` (#2800) — vendor a component + its
/// transitive closure (or the whole kit) as compilable source, from the EMBEDDED artifact (no store /
/// network → sandbox-safe). See [`crate::emit`].
/// `bsc ui harvest <repo-dir>` (#3471) — scan a repo for reusable component candidates. READ-ONLY, so
/// no write-scope gate: it emits candidates and stores nothing (mirroring `bsc graph harvest`, where
/// storing is the curation gate's job). Pure JSON out, `--pretty` to indent.
fn cmd_harvest(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("help") {
        print!("{}", bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "harvest"));
        return Ok(());
    }
    let mut target: Option<&str> = None;
    let (mut kit, mut worthy_only, mut pretty) = (crate::harvest::DEFAULT_KIT.to_string(), false, false);
    let mut out: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--kit" => kit = it.next().cloned().ok_or("--kit needs a kit id")?,
            "--worthy-only" => worthy_only = true,
            "--pretty" => pretty = true,
            "--out" => out = Some(it.next().cloned().ok_or("--out needs a bare file name")?),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => target = Some(other),
        }
    }
    let target = target
        .ok_or("usage: bsc ui harvest <repo-dir-or-file> [--kit K] [--worthy-only] [--out <name>] [--pretty]")?;
    let path = std::path::Path::new(target);
    // #3722: a single FILE is a valid target now (scope to one component's module) — not only a dir.
    let is_file = path.is_file();
    if !path.is_dir() && !is_file {
        return Err(format!("no such file or directory: {target}"));
    }
    // #3475: a harvest hands back file CONTENTS, so it must honor the SAME boundary the file tools do.
    // `bsc-confine` only inspects Claude's file-tool payloads and is blind to what this binary reads —
    // without this, a confined studio session (designer/librarian) reads any path on disk through an
    // allow-listed CLI. Checked after the existence test so the target is known to exist.
    bsc_cli_util::require_harvestable_root(path)?;
    let mut candidates =
        if is_file { crate::harvest::harvest_file(path, &kit) } else { crate::harvest::harvest(path, &kit) };
    if worthy_only {
        candidates.retain(|c| c.classification.worthy);
    }
    let items: Vec<serde_json::Value> = candidates.iter().map(harvest_json).collect();
    let mut payload = serde_json::json!({ "candidates": items, "count": items.len() });
    // #3740: surface the functional/algorithmic modules (functions, hooks, utils) this component harvest
    // SKIPS — they belong in the ALGORITHMS graph, not the component graph. Route them to `bsc graph
    // harvest` so they aren't lost between the two harvests. Omitted entirely when the tree has none.
    let functional = crate::harvest::functional_module_names(path);
    if let Some(note) = harvest_note(target, functional.len(), items.len(), is_file) {
        payload["note"] = serde_json::json!(note);
    }
    if !functional.is_empty() {
        payload["functionalModules"] = serde_json::json!(functional);
    }
    let text = if pretty {
        serde_json::to_string_pretty(&payload)
    } else {
        serde_json::to_string(&payload)
    }
    .map_err(|e| e.to_string())?;
    // #3722: `--out <name>` spills the JSON to the session scratch dir — a confinement-allowed path the
    // session Reads in full — instead of stdout, which a restricted session truncates for a large harvest
    // (and spills OUT of the confinement, unreadable). Symmetric with `bsc ui get --out` (#20).
    match out {
        Some(name) => {
            let file = bsc_cli_util::resolve_scratch_out(&name)?;
            std::fs::write(&file, format!("{text}\n"))
                .map_err(|e| format!("cannot write --out {}: {e}", file.display()))?;
            println!("{}", file.display());
        }
        None => println!("{text}"),
    }
    Ok(())
}

/// The harvest's routing `note` — what to run NEXT for the part of `target` this harvest did not lift.
/// `None` when the harvest lifted components and nothing else needs saying.
///
/// #3740 routed functional/algorithmic modules to `bsc graph harvest`. #4161 adds the case that route
/// never covered: a module that is NEITHER a component NOR a function — a const/type module like a
/// `STATUS_META` table. Both harvests are silent on it by design, so a caller trying to vendor a
/// component that imports one got an empty result and no next move (reported four times: designer
/// requests #9, #28, #32, #51). `bsc files read` is that move.
fn harvest_note(target: &str, functional: usize, candidates: usize, is_file: bool) -> Option<String> {
    if functional > 0 {
        return Some(format!(
            "{functional} functional/algorithmic module(s) here are NOT components — harvest them into the \
             algorithms graph with `bsc graph harvest {target}` (functions, hooks, and utils belong there). \
             For a module NEITHER harvest lifts — a const/type module such as a STATUS_META table — read \
             its text with `bsc files read <path>`."
        ));
    }
    if is_file && candidates == 0 {
        return Some(format!(
            "no components and no functional modules here — if this is a const/type module (a metadata \
             table, a shared types file), read its text with `bsc files read {target}`; neither harvest \
             lifts a plain `export const`."
        ));
    }
    None
}

/// `bsc ui env [--json]` (#3571) — surface the session-scoped environment a confined studio session
/// runs under, chiefly the READ-only HARVEST roots it may scan. A designer/librarian session is cwd'd
/// in its own sealed workspace, not the repo, so without this it has no way to DISCOVER where the app's
/// UI lives — the reach was granted (`$BSC_HARVEST_ROOTS`) but never surfaced, so `harvest` refused every
/// guessed path with only a terse "outside every root". READ-ONLY (no scope gate); the report itself
/// lives in `bsc-cli-util` so `bsc graph env` can adopt it too.
fn cmd_env(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("help") => {
            print!("{}", bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "env"));
            Ok(())
        }
        Some("--json") => {
            let s = bsc_cli_util::session_env_snapshot();
            let out = serde_json::json!({
                "scratch": s.scratch,
                "scopes": s.scopes,
                "repoRoot": s.repo_root,
                "harvestRoots": s.harvest_roots,
                "harvestableRoots": s.harvestable_roots(),
            });
            println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
            Ok(())
        }
        Some(other) => Err(format!("unknown flag '{other}' — usage: bsc ui env [--json]")),
        None => {
            print!("{}", bsc_cli_util::format_session_env("bsc ui"));
            Ok(())
        }
    }
}

/// One harvested candidate as the store's component-record shape (plus the harvest-only verdict
/// fields), so a curator can pipe it straight into `bsc ui set` after review. Seeds `group` as the
/// component's FOLDER PATH derived from `src` (#3579, [`bsc_component::folder_from_src`]) so a fresh
/// harvest organizes like the project's folders; omitted (not `null`) when `src` yields no folder, per
/// the "absent ⇒ unfoldered" record convention.
fn harvest_json(c: &crate::harvest::Candidate) -> serde_json::Value {
    let mut v = serde_json::json!({
        "id": c.id,
        "name": c.name,
        "kitId": c.kit_id,
        "role": c.role,
        "composes": c.composes,
        "srcText": c.src_text,
        "src": c.src,
        "buildable": c.buildable,
        "unbuildableReasons": c.unbuildable_reasons,
        "worthy": c.classification.worthy,
        "score": c.classification.score,
        "reasons": c.classification.reasons,
    });
    if let Some(folder) = bsc_component::folder_from_src(&c.src) {
        v["folder"] = serde_json::Value::String(folder);
    }
    v
}

fn cmd_emit(args: &[String], prog: &str) -> Result<(), String> {
    match args.first().map(String::as_str) {
        None | Some("help") => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "emit"));
            Ok(())
        }
        Some("component") => {
            let id = args.get(1).ok_or("usage: bsc ui emit component <id> <dir>")?;
            let dir = args.get(2).ok_or("usage: bsc ui emit component <id> <dir>")?;
            // #3720: resolve against the WHOLE store (any kit) when it's reachable, else the packaged
            // react-ui artifact (the sealed-sandbox fallback — the store isn't mounted there).
            write_plan(&emit_kit().plan_component(id)?, dir)
        }
        Some("kit") => {
            let dir = args.get(1).ok_or("usage: bsc ui emit kit <dir>")?;
            write_plan(&crate::emit::EmitKit::packaged().plan_kit(), dir)
        }
        Some("sync") => {
            let dir = args.get(1).ok_or("usage: bsc ui emit sync <dir>")?;
            cmd_sync(dir)
        }
        Some(other) => Err(format!(
            "unknown emit command '{other}' — want: component <id> <dir> | kit <dir> | sync <dir>"
        )),
    }
}

/// The `EmitKit` `emit component` resolves against (#3720): the live component STORE overlaid on the
/// packaged artifact when the store is reachable (so ANY kit's component emits), else the packaged
/// artifact alone — the sealed-sandbox fallback, where the mutable store isn't mounted and react-ui still
/// emits. A store that resolves but is empty (a fresh install) also falls back to packaged.
fn emit_kit() -> crate::emit::EmitKit {
    match load_store_components() {
        Ok(comps) if !comps.is_empty() => crate::emit::EmitKit::from_store(&comps),
        _ => crate::emit::EmitKit::packaged(),
    }
}

/// Every component record in the working store (`BSC_COMPONENT_DIR` → `~/.base-studio-code/components/`),
/// parsed; malformed rows are skipped. `Err` only when the store dir can't be resolved (no home) — the
/// caller treats that, like an empty store, as "fall back to packaged".
fn load_store_components() -> Result<Vec<serde_json::Value>, String> {
    let store = component_collection("components", "BSC_COMPONENT_DIR", "component")?;
    Ok(store.list().iter().filter_map(|j| serde_json::from_str(j).ok()).collect())
}

/// `bsc ui emit sync <dir>` (#2804) — the ADOPT step: re-emit every MANAGED vendored kit file (one
/// untouched since it was emitted) from the current embedded artifact, and WARN + skip every DIVERGED
/// (hand-edited) one instead of clobbering it (fall loudly). This is how a kit change is adopted — by
/// re-running the command, never by hand-editing — so a worker the director routes just runs this.
/// Prints `{ dir, synced, upToDate, diverged, unknown }`.
fn cmd_sync(dir: &str) -> Result<(), String> {
    let kit = crate::emit::EmitKit::packaged();
    let mut files: Vec<(String, String)> = Vec::new();
    collect_source_files_into(Path::new(dir), Path::new(dir), &mut files)?;
    let (mut synced, mut up_to_date, mut diverged, mut unknown) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (rel, content) in &files {
        match kit.classify(rel, content) {
            crate::emit::SyncVerdict::NotVendored => {}
            crate::emit::SyncVerdict::UpToDate => up_to_date.push(rel.clone()),
            crate::emit::SyncVerdict::Diverged => diverged.push(rel.clone()),
            crate::emit::SyncVerdict::Unknown => unknown.push(rel.clone()),
            crate::emit::SyncVerdict::Rewrite(fresh) => {
                let out = Path::new(dir).join(rel);
                std::fs::write(&out, &fresh).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
                synced.push(rel.clone());
            }
        }
    }
    let summary = serde_json::json!({
        "dir": dir, "synced": synced, "upToDate": up_to_date, "diverged": diverged, "unknown": unknown,
    });
    println!("{}", serde_json::to_string(&summary).map_err(|e| e.to_string())?);
    Ok(())
}

/// Write every planned file under `dir` (creating parent dirs) and print the JSON summary
/// `{ emitted, dir, files, externalDeps }`.
fn write_plan(plan: &crate::emit::EmitPlan, dir: &str) -> Result<(), String> {
    let root = Path::new(dir);
    for f in &plan.files {
        let out = root.join(&f.path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        std::fs::write(&out, &f.content).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    }
    let summary = serde_json::json!({
        "emitted": plan.files.len(),
        "dir": dir,
        "files": plan.files.iter().map(|f| &f.path).collect::<Vec<_>>(),
        "externalDeps": plan.external_deps,
    });
    println!("{}", serde_json::to_string(&summary).map_err(|e| e.to_string())?);
    Ok(())
}

fn cmd_schema(args: &[String]) -> Result<(), String> {
    let pretty = args.iter().any(|a| a == "--pretty");
    // #3500 — this now prints the PRIMITIVE contract (the general vocabulary: every real component of
    // the shared kit and the props it declares), not the 8 hardcoded node kinds it used to. It is the
    // same generated contract `bsc ui validate` enforces, so what an agent reads here is exactly what
    // it will be checked against. `--name` narrows it, because the full kit is large and an agent
    // authoring one node wants one entry.
    let contract: serde_json::Value = serde_json::from_str(crate::general_node::PRIMITIVES_JSON)
        .map_err(|e| format!("embedded primitives.json is not valid JSON: {e}"))?;
    let mut wanted: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--name" {
            wanted = Some(it.next().cloned().ok_or("--name needs a primitive name")?);
        }
    }
    let contract = match wanted {
        Some(name) => {
            let found = contract
                .get("primitives")
                .and_then(serde_json::Value::as_array)
                .and_then(|list| {
                    list.iter()
                        .find(|p| p.get("name").and_then(serde_json::Value::as_str) == Some(&name))
                        .cloned()
                });
            found.ok_or_else(|| {
                format!("unknown primitive \"{name}\" — run `bsc ui schema` for the full contract")
            })?
        }
        None => contract,
    };
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
        // #4152: through the shared emitter so a warm serve loop CAPTURES this into its response rather
        // than leaking it onto the protocol stream. Identical to `println!` when nothing is capturing.
        // These local closures bypassed `print_json`, which is what the byte-comparison against a
        // one-shot run caught — the response came back empty while the payload appeared as a stray line.
        bsc_util::emit_line(&s.map_err(|e| e.to_string())?);
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

/// Decode the persisted app-state's pending kit-change dispatches (#2951) — the double-encoded zustand
/// snapshot's `.state.kitDispatches` (each `{ projectKey, change }`). Pure + total: an empty vec when
/// the file isn't the expected shape or the field is absent.
fn decode_kit_changes(contents: &str) -> Vec<serde_json::Value> {
    (|| -> Option<Vec<serde_json::Value>> {
        let file: serde_json::Value = serde_json::from_str(contents).ok()?;
        let inner = file.get("app-state")?.as_str()?;
        let snapshot: serde_json::Value = serde_json::from_str(inner).ok()?;
        snapshot.get("state")?.get("kitDispatches")?.as_array().cloned()
    })()
    .unwrap_or_default()
}

/// Read + decode the pending kit-change dispatches from an app-state.json PATH (#2951); an empty vec
/// when the file is missing/unreadable/not the expected shape.
fn read_kit_changes(path: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path).ok().map(|c| decode_kit_changes(&c)).unwrap_or_default()
}

/// Group the flat `{ projectKey, change }` dispatches into one entry per change (first-seen order):
/// `{ change, consumers }`, the consumer project keys it propagates to. Pure — the shape printed.
fn group_kit_changes(dispatches: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for d in dispatches {
        let change = match d.get("change") {
            Some(c) => c,
            None => continue,
        };
        let id = change.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let pk = d.get("projectKey").cloned().unwrap_or(serde_json::Value::Null);
        match out.iter_mut().find(|g| {
            g.get("change").and_then(|c| c.get("id")).and_then(|v| v.as_str()) == Some(id)
        }) {
            Some(g) => {
                if let Some(arr) = g.get_mut("consumers").and_then(|c| c.as_array_mut()) {
                    arr.push(pk);
                }
            }
            None => out.push(serde_json::json!({ "change": change.clone(), "consumers": [pk] })),
        }
    }
    out
}

/// `bsc ui changes list [--json] [--pretty]` (#2951) — READ-ONLY: the pending kit-change confirmations
/// the running app has queued (from `app-state.json`, like `theme active`). One `{ change, consumers }`
/// per change. Never writes app-state. `list` is implicit (the only verb); flags select the format.
fn cmd_changes(args: &[String]) -> Result<(), String> {
    if let Some(bad) = args.iter().find(|a| a.starts_with("--") && *a != "--json" && *a != "--pretty") {
        return Err(format!("unknown flag '{bad}' — want: bsc ui changes list [--json] [--pretty]"));
    }
    let json = args.iter().any(|a| a == "--json");
    let pretty = args.iter().any(|a| a == "--pretty");
    let dispatches = app_state_path().map(|p| read_kit_changes(&p)).unwrap_or_default();
    let grouped = group_kit_changes(&dispatches);
    if json || grouped.is_empty() {
        let v = serde_json::Value::Array(grouped);
        let out = if pretty { serde_json::to_string_pretty(&v) } else { serde_json::to_string(&v) };
        println!("{}", out.map_err(|e| e.to_string())?);
    } else {
        for g in &grouped {
            let change = g.get("change");
            let class = change.and_then(|c| c.get("class")).and_then(|v| v.as_str()).unwrap_or("?");
            let comp = change.and_then(|c| c.get("component")).and_then(|v| v.as_str()).unwrap_or("?");
            let summary = change.and_then(|c| c.get("summary")).and_then(|v| v.as_str()).unwrap_or("");
            let consumers: Vec<&str> = g
                .get("consumers")
                .and_then(|c| c.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            println!("[{class}] {comp} — {summary}  → {}", consumers.join(", "));
        }
    }
    Ok(())
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
        // #4152: through the shared emitter so a warm serve loop CAPTURES this into its response rather
        // than leaking it onto the protocol stream. Identical to `println!` when nothing is capturing.
        // These local closures bypassed `print_json`, which is what the byte-comparison against a
        // one-shot run caught — the response came back empty while the payload appeared as a stray line.
        bsc_util::emit_line(&s.map_err(|e| e.to_string())?);
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
                // Mandatory design-group binding (#2749): a theme MUST declare its `tech`. Reject
                // BEFORE the store write so a group-less theme can never be persisted.
                match item.get("tech").and_then(serde_json::Value::as_str) {
                    Some(t) if !t.trim().is_empty() => {}
                    _ => {
                        return Err(format!(
                            "theme '{id}' must declare its design group — add a non-empty string \"tech\" (e.g. \"react\")"
                        ))
                    }
                }
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
            // Full theme validation (#2749): the mandatory `tech` design-group binding + the `vars`.
            let errs = crate::validate_theme(&theme);
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
    let mut from_store = None::<String>;
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
            "--from-store" => from_store = it.next().cloned(),
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
        // #4152: through the shared emitter so a warm serve loop CAPTURES this into its response rather
        // than leaking it onto the protocol stream. Identical to `println!` when nothing is capturing.
        // These local closures bypassed `print_json`, which is what the byte-comparison against a
        // one-shot run caught — the response came back empty while the payload appeared as a stray line.
        bsc_util::emit_line(&s.map_err(|e| e.to_string())?);
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
            let id = positional.get(1).ok_or("usage: bsc ui release add <id> <version> [--kind K] [--source URL] [--sha256 HEX] [--file PATH | --from-store KIT]")?;
            let version = positional.get(2).ok_or("usage: bsc ui release add <id> <version> …")?;
            // Source the artifact: assembled from a live kit in the component store (--from-store), else
            // read from --file / stdin. The two sources are mutually exclusive.
            let content = if let Some(kit_id) = &from_store {
                if file.is_some() {
                    return Err("give either --from-store <kit> or --file <path>, not both".into());
                }
                if kind != "component-kit" {
                    return Err(format!(
                        "--from-store assembles a component-kit from the component library, so it is incompatible with --kind {kind}"
                    ));
                }
                assemble_from_store(id, version, kit_id)?
            } else {
                match &file {
                    Some(p) => std::fs::read_to_string(p).map_err(|e| format!("cannot read {p}: {e}"))?,
                    None => {
                        let mut s = String::new();
                        std::io::stdin().read_to_string(&mut s).map_err(|e| format!("cannot read stdin: {e}"))?;
                        s
                    }
                }
            };
            // Refuse a hollow / shapeless release BEFORE writing the immutable entry (#3167): an empty
            // artifact, or a component-kit that doesn't parse or carries zero components, is rejected.
            crate::kit::validate_artifact(&kind, &content)?;
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

/// Open a bsc-component collection store the way `bsc ui` / `bsc component` locates it (#3167,
/// `--from-store`): the shared `$ENV → ~/.base-studio-code/<segment>/` precedence (no `--dir` — that
/// flag names the RELEASE store, not the component library). So `--from-store` reads the live library a
/// designer session authored, honoring the SAME env overrides that session's component/kit stores use.
fn component_collection(segment: &str, env: &str, noun: &'static str) -> Result<bsc_json_store::Store, String> {
    let dir = bsc_cli_util::resolve_store_path(&None, env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(segment))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(bsc_json_store::Store::new(dir, noun))
}

/// Assemble a `component-kit` release artifact directly from the live component store (#3167,
/// `--from-store <kit>`) — the one-shot alternative to hand-piping a `--file`. Reads the kit record
/// (the flat kit collection, `BSC_COMPONENT_KIT_DIR`) + every component whose `kitId` is `<kit>` (the
/// component collection, `BSC_COMPONENT_DIR`) and builds the same `{ id, version, kit, components }`
/// shape `release add --file` expects, via [`crate::kit::assemble_artifact`]. `id`/`version` are the
/// RELEASE's identity (the positional args). Errors loudly when the kit isn't in the store or has no
/// components — the pipeline-failed cases #3167 is closing, surfaced before anything is stored.
fn assemble_from_store(id: &str, version: &str, kit_id: &str) -> Result<String, String> {
    // The components: the working component library (BSC_COMPONENT_DIR → ~/.base-studio-code/components/),
    // filtered to this kit — the same read `bsc ui list` / the desktop library performs.
    let comp_store = component_collection("components", "BSC_COMPONENT_DIR", "component")?;
    let components: Vec<serde_json::Value> = comp_store
        .list()
        .iter()
        .filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok())
        .filter(|c| c.get("kitId").and_then(serde_json::Value::as_str) == Some(kit_id))
        .collect();
    if components.is_empty() {
        return Err(format!(
            "kit '{kit_id}' has no components in the store — nothing to release. Author components with `bsc ui set` (kitId: \"{kit_id}\") first."
        ));
    }
    // The kit record: the flat kit collection (BSC_COMPONENT_KIT_DIR → ~/.base-studio-code/kits/).
    let kit_store = component_collection("kits", "BSC_COMPONENT_KIT_DIR", "kit")?;
    let kit = match kit_store.get(kit_id)? {
        Some(j) => serde_json::from_str::<serde_json::Value>(&j)
            .map_err(|e| format!("kit '{kit_id}' record is not valid JSON: {e}"))?,
        None => {
            return Err(format!(
                "kit '{kit_id}' is not in the kit store — `bsc ui kit set` it first (or check the id)"
            ))
        }
    };
    Ok(crate::kit::assemble_artifact(id, version, kit, components))
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
    fn emit_component_writes_a_stamped_alias_free_closure() {
        // The CLI path end-to-end (#2800): emit `card` into a temp dir, from the EMBEDDED artifact.
        let dir = std::env::temp_dir().join(format!("bsc-ui-emit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let d = dir.to_string_lossy().into_owned();
        run(vec!["emit".into(), "component".into(), "card".into(), d.clone()], "bsc ui").unwrap();
        // Card landed mirroring the src/ layout, with NO first-party alias surviving, provenance-stamped.
        let card = std::fs::read_to_string(dir.join("shared/ui/data/Card.tsx")).expect("Card.tsx emitted");
        assert!(!card.contains("@/"), "emitted Card retains a @/ alias: {card}");
        assert!(card.starts_with("// vendored from bsc/react-ui@"), "provenance stamp: {card}");
        // Command surface: bare emit prints help; bad shapes error crisply.
        assert!(run(vec!["emit".into()], "bsc ui").is_ok(), "bare emit prints help");
        assert!(run(vec!["emit".into(), "component".into(), "nope".into(), d], "bsc ui").is_err(), "unknown id");
        assert!(run(vec!["emit".into(), "kit".into()], "bsc ui").is_err(), "kit needs a dir");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn emit_help_documents_both_forms() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "emit");
        for needle in ["emit component", "emit kit", "emit sync", "externalDeps", "diverged", "sandbox", "vendored from"] {
            assert!(d.contains(needle), "emit help mentions {needle}");
        }
    }

    #[test]
    fn emit_sync_round_trips_up_to_date_and_flags_hand_edits_diverged() {
        // Emit `card`, then sync the same dir — every file is up-to-date (nothing rewritten).
        let dir = std::env::temp_dir().join(format!("bsc-ui-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let d = dir.to_string_lossy().into_owned();
        run(vec!["emit".into(), "component".into(), "card".into(), d.clone()], "bsc ui").unwrap();
        run(vec!["emit".into(), "sync".into(), d.clone()], "bsc ui").unwrap(); // a no-op adopt — must not error
        let card_path = dir.join("shared/ui/data/Card.tsx");
        let before = std::fs::read_to_string(&card_path).unwrap();
        run(vec!["emit".into(), "sync".into(), d.clone()], "bsc ui").unwrap();
        assert_eq!(std::fs::read_to_string(&card_path).unwrap(), before, "a managed, current file is untouched by sync");
        // Hand-edit the body → sync must NOT clobber it (diverged, fall loudly).
        std::fs::write(&card_path, format!("{before}\n// human tweak")).unwrap();
        run(vec!["emit".into(), "sync".into(), d], "bsc ui").unwrap();
        assert!(std::fs::read_to_string(&card_path).unwrap().contains("// human tweak"), "a diverged file is left as-is");
        // Bad shape: sync needs a dir.
        assert!(run(vec!["emit".into(), "sync".into()], "bsc ui").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_help_explains_the_store_contract() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "release");
        for needle in ["id@version", "immutable", "--sha256", "bsc/react-ui", "--from-store", "hollow"] {
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
        // add via --file (stdin isn't drivable in a unit test). A real component-kit shape (#3167: the
        // add gate refuses anything that isn't { …, components: [ … ] } with ≥1 component).
        let artifact = dir.join("artifact-src.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&artifact, "{\"id\":\"acme/neon\",\"version\":\"1.0.0\",\"kit\":{\"id\":\"neon\"},\"components\":[{\"id\":\"btn\",\"kitId\":\"neon\"}]}").unwrap();
        run_kit(&["add", "acme/neon", "1.0.0", "--file", artifact.to_str().unwrap()]).unwrap();
        run_kit(&["list", "--pretty"]).unwrap();
        run_kit(&["get", "acme/neon@1.0.0"]).unwrap();
        run_kit(&["get", "acme/neon@1.0.0", "--artifact"]).unwrap();
        run_kit(&["verify", "acme/neon@1.0.0"]).unwrap();
        // A wrong --sha256 is a hard error (nothing stored).
        assert!(run_kit(&["add", "acme/other", "1.0.0", "--file", artifact.to_str().unwrap(), "--sha256", "beef"]).is_err());
        assert!(run_kit(&["get", "acme/other@1.0.0"]).is_ok(), "get of the never-stored entry still prints null");
        // #3167: a HOLLOW artifact is refused BEFORE the immutable entry is written — nothing stored.
        let empty = dir.join("empty.json");
        std::fs::write(&empty, "").unwrap();
        assert!(run_kit(&["add", "acme/hollow", "1.0.0", "--file", empty.to_str().unwrap()]).is_err(), "empty --file refused");
        let zero = dir.join("zero.json");
        std::fs::write(&zero, "{\"kit\":{},\"components\":[]}").unwrap();
        assert!(run_kit(&["add", "acme/hollow", "1.0.0", "--file", zero.to_str().unwrap()]).is_err(), "zero-component artifact refused");
        let junk = dir.join("junk.json");
        std::fs::write(&junk, "{ not json").unwrap();
        assert!(run_kit(&["add", "acme/hollow", "1.0.0", "--file", junk.to_str().unwrap()]).is_err(), "unparseable artifact refused");
        assert_eq!(run_kit(&["get", "acme/hollow@1.0.0"]), Ok(()), "the refused entry never materialized");
        run_kit(&["remove", "acme/neon@1.0.0"]).unwrap();
        // Bad shapes error crisply.
        assert!(run_kit(&["get", "acme/neon"]).is_err(), "a ref without @version is rejected");
        assert!(run_kit(&["frobnicate"]).is_err());
        // --from-store + --file together is a contradiction (rejected before any store read).
        assert!(run_kit(&["add", "acme/x", "1.0.0", "--from-store", "neon", "--file", artifact.to_str().unwrap()]).is_err());
        // --from-store with a design-files kind is incompatible (assembly is component-kit only).
        assert!(run_kit(&["add", "acme/x", "1.0.0", "--from-store", "neon", "--kind", "design-files"]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn release_add_from_store_assembles_a_non_empty_artifact() {
        // --from-store reads the LIVE component library (BSC_COMPONENT_DIR / BSC_COMPONENT_KIT_DIR) — set
        // both to scratch dirs under a lock (the env is process-global; every other test uses --dir).
        static FROM_STORE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = FROM_STORE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());

        let base = std::env::temp_dir().join(format!("bsc-ui-from-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let comp_dir = base.join("components");
        let kit_dir = base.join("kits");
        let rel_dir = base.join("releases");
        std::fs::create_dir_all(&comp_dir).unwrap();
        std::fs::create_dir_all(&kit_dir).unwrap();

        // Seed the component + kit collections the way a designer session would (bsc ui set / kit set).
        let comp_store = bsc_json_store::Store::new(comp_dir.clone(), "component");
        comp_store.set("btn", "{\"id\":\"btn\",\"name\":\"Button\",\"kitId\":\"neon\"}").unwrap();
        comp_store.set("card", "{\"id\":\"card\",\"name\":\"Card\",\"kitId\":\"neon\"}").unwrap();
        comp_store.set("other", "{\"id\":\"other\",\"name\":\"Other\",\"kitId\":\"elsewhere\"}").unwrap();
        let kit_store = bsc_json_store::Store::new(kit_dir.clone(), "kit");
        kit_store.set("neon", "{\"id\":\"neon\",\"name\":\"neon\",\"tech\":\"react\",\"style\":\"studio\"}").unwrap();

        std::env::set_var("BSC_COMPONENT_DIR", &comp_dir);
        std::env::set_var("BSC_COMPONENT_KIT_DIR", &kit_dir);

        let run_rel = |rest: &[&str]| {
            let mut args = vec!["release".to_string()];
            args.extend(rest.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), rel_dir.to_string_lossy().into_owned()]);
            run(args, "bsc ui")
        };
        // One-shot: the release is ASSEMBLED from the live kit, not hand-piped through --file.
        run_rel(&["add", "acme/neon", "1.0.0", "--from-store", "neon"]).unwrap();
        run_rel(&["verify", "acme/neon@1.0.0"]).unwrap();

        // The stored artifact is the assembled, non-empty component-kit — EXACTLY this kit's components
        // (btn, card), not the component in the other kit; and it embeds the live kit record.
        let release_store = crate::kit::KitStore::new(rel_dir.clone());
        let artifact = release_store.artifact("acme/neon", "1.0.0").unwrap().expect("artifact stored");
        let parsed: serde_json::Value = serde_json::from_str(&artifact).unwrap();
        assert_eq!(parsed["id"], "acme/neon");
        assert_eq!(parsed["version"], "1.0.0");
        assert_eq!(parsed["kit"]["id"], "neon", "the live kit record is embedded");
        let ids: Vec<&str> =
            parsed["components"].as_array().unwrap().iter().filter_map(|c| c["id"].as_str()).collect();
        assert_eq!(ids, vec!["btn", "card"], "only this kit's components (never 'other'): {ids:?}");

        // A kit with no components in the store is refused (nothing to release) — never a hollow entry.
        assert!(run_rel(&["add", "acme/empty", "1.0.0", "--from-store", "nope"]).is_err(), "empty/unknown kit refused");

        std::env::remove_var("BSC_COMPONENT_DIR");
        std::env::remove_var("BSC_COMPONENT_KIT_DIR");
        let _ = std::fs::remove_dir_all(&base);
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

    // ── `changes list` — read the running app's pending kit-change confirmations (#2951) ─────────────

    #[test]
    fn changes_help_is_documented() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "changes");
        for needle in ["list", "read-only", "consumers", "app-state.json", "--json"] {
            assert!(d.contains(needle), "changes help mentions {needle}");
        }
    }

    #[test]
    fn decode_kit_changes_reads_the_double_encoded_dispatches() {
        let inner = serde_json::json!({
            "state": { "kitDispatches": [
                { "projectKey": "acme", "change": { "id": "c1", "class": "breaking", "component": "Button", "summary": "renamed prop" } }
            ] },
            "version": 1,
        })
        .to_string();
        let out = decode_kit_changes(&serde_json::json!({ "app-state": inner }).to_string());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["change"]["id"], "c1");
        // Absent / malformed → empty, never a panic.
        assert!(decode_kit_changes(&serde_json::json!({ "other": 1 }).to_string()).is_empty());
        assert!(decode_kit_changes("}{ not json").is_empty());
    }

    #[test]
    fn group_kit_changes_folds_dispatches_by_change_with_their_consumers() {
        let mk = |change: &str, project: &str| {
            serde_json::json!({ "projectKey": project, "change": { "id": change, "class": "additive", "component": "Card", "summary": "s" } })
        };
        let grouped = group_kit_changes(&[mk("c1", "a"), mk("c1", "b"), mk("c2", "a")]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0]["change"]["id"], "c1");
        assert_eq!(grouped[0]["consumers"], serde_json::json!(["a", "b"]));
        assert_eq!(grouped[1]["consumers"], serde_json::json!(["a"]));
    }

    #[test]
    fn changes_list_reads_the_override_and_rejects_a_bad_flag() {
        let _guard = APP_STATE_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let path = std::env::temp_dir().join(format!("bsc-ui-changes-{}.json", std::process::id()));
        let inner = serde_json::json!({
            "state": { "kitDispatches": [
                { "projectKey": "acme", "change": { "id": "c1", "class": "fix", "component": "Chip", "summary": "x" } }
            ] },
            "version": 1,
        })
        .to_string();
        std::fs::write(&path, serde_json::json!({ "app-state": inner }).to_string()).unwrap();
        std::env::set_var(APP_STATE_ENV, &path);
        assert!(run(vec!["changes".into(), "list".into()], "bsc ui").is_ok());
        assert!(run(vec!["changes".into(), "list".into(), "--json".into(), "--pretty".into()], "bsc ui").is_ok());
        std::env::remove_var(APP_STATE_ENV);
        let _ = std::fs::remove_file(&path);
        // A bad flag errors before any app-state read.
        assert!(run(vec!["changes".into(), "--nope".into()], "bsc ui").is_err());
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
        std::fs::write(&src, r#"{"id":"neon","tech":"react","label":"Neon","description":"glow","vars":{"--card-bg":"black"}}"#).unwrap();
        run_theme(&["set", "--file", src.to_str().unwrap()]).unwrap();
        let store = bsc_json_store::Store::new(dir.clone(), "theme");
        // `set` re-serializes each item through serde_json::Value (that's what lets an array upsert
        // per element), so key ORDER follows serde_json's map (alphabetical without preserve_order) —
        // compare parsed values, not bytes (#2515: the old byte-equality assert encoded an order the
        // code never promised).
        let stored: serde_json::Value =
            serde_json::from_str(&store.get("neon").unwrap().unwrap()).unwrap();
        let expected: serde_json::Value = serde_json::from_str(
            r#"{"id":"neon","tech":"react","label":"Neon","description":"glow","vars":{"--card-bg":"black"}}"#,
        )
        .unwrap();
        assert_eq!(stored, expected, "stored content round-trips semantically");
        run_theme(&["get", "neon"]).unwrap();
        run_theme(&["get", "neon", "--pretty"]).unwrap();
        // An array upserts every element by id.
        std::fs::write(&src, r#"[{"id":"a1","tech":"react","label":"A","description":"","vars":{}},{"id":"b2","tech":"react","label":"B","description":"","vars":{}}]"#).unwrap();
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
        std::fs::write(&src, r#"{"id":"neon","tech":"react","label":"Neon","description":"glow","vars":{}}"#).unwrap();
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

    #[test]
    fn harvest_dispatches_parses_its_flags_and_rejects_bad_input() {
        // Covers the CLI surface the library tests can't see: the dispatch arm, flag parsing, and the
        // read-only contract (no write-scope gate — harvest emits candidates, it stores nothing).
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").join("harvest").to_string_lossy().into_owned();
        assert!(run(vec!["harvest".into(), dir.clone(), "--pretty".into()], "bsc ui").is_ok());
        assert!(run(
            vec!["harvest".into(), dir, "--kit".into(), "demo".into(), "--worthy-only".into()],
            "bsc ui",
        )
        .is_ok());
        // A missing/!dir path and an unknown flag must FAIL rather than emit an empty harvest, which
        // would read as "this repo has no components".
        assert!(run(vec!["harvest".into(), "no-such-dir-here".into()], "bsc ui").is_err());
        assert!(run(vec!["harvest".into(), ".".into(), "--nope".into()], "bsc ui").is_err());
        assert!(run(vec!["harvest".into()], "bsc ui").is_err(), "the repo dir is required");
    }

    #[test]
    fn harvest_json_seeds_group_as_the_folder_path_from_src() {
        // #3579: a fresh harvest organizes like the project's folders — `group` is seeded from `src`.
        let mk = |src: &str| crate::harvest::Candidate {
            id: "button".into(),
            name: "Button".into(),
            kit_id: "harvested".into(),
            role: "primitive",
            composes: vec![],
            src_text: String::new(),
            src: src.into(),
            buildable: true,
            unbuildable_reasons: vec![],
            classification: crate::harvest::Classification::default(),
        };
        let with_folder = harvest_json(&mk("src/shared/ui/controls/Button.tsx"));
        assert_eq!(with_folder["folder"], "shared/ui/controls", "seeded as the folder path");
        // No folder ⇒ the key is OMITTED (not `null`), matching the absent-⇒-ungrouped record convention.
        let no_folder = harvest_json(&mk("Button.tsx"));
        assert!(no_folder.get("folder").is_none(), "a folderless src emits no `folder` key at all");
    }

    #[test]
    fn harvest_is_allowed_from_a_read_only_listed_root_outside_the_confinement_root() {
        // #3509, proposed by the designer itself: harvest is a READ, so tying it to the WRITE
        // confinement root left a kit-only session unable to mine any source at all (its studio dir
        // holds none). A listed harvest root grants the read without widening where it may write.
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").join("harvest").to_string_lossy().into_owned();
        let elsewhere = std::env::temp_dir().to_string_lossy().into_owned();
        // Confined elsewhere → refused, as before.
        assert!(bsc_cli_util::with_repo_root(Some(&elsewhere), || {
            run(vec!["harvest".into(), fixtures.clone()], "bsc ui")
        })
        .is_err());
        // …and allowed once that tree is on the session's harvest allow-list.
        assert!(
            bsc_cli_util::with_repo_root(Some(&elsewhere), || bsc_cli_util::with_harvest_roots(
                Some(&fixtures),
                || run(vec!["harvest".into(), fixtures.clone()], "bsc ui"),
            ))
            .is_ok(),
            "a listed harvest root must permit the scan",
        );
    }

    #[test]
    fn harvest_accepts_a_single_file_and_out_spills_to_the_scratch_dir() {
        // #3722: a single FILE target (not only a dir), and `--out` writing the JSON to the scratch dir
        // (a confinement-allowed path) instead of stdout — the truncation fix for a large harvest.
        let base = std::env::temp_dir().join(format!("bsc-harvest-cli-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (root, scratch) = (base.join("root"), base.join("scratch"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        let file = root.join("Widget.tsx");
        std::fs::write(&file, "export const Widget = () => <div/>;").unwrap();

        let root_s = root.to_string_lossy().into_owned();
        let scratch_s = scratch.to_string_lossy().into_owned();
        let file_s = file.to_string_lossy().into_owned();
        bsc_cli_util::with_repo_root(Some(&root_s), || {
            bsc_cli_util::with_scratch(Some(&scratch_s), || {
                run(vec!["harvest".into(), file_s.clone(), "--out".into(), "harvest.json".into()], "bsc ui").unwrap();
            });
        });
        let written = std::fs::read_to_string(scratch.join("harvest.json")).unwrap();
        assert!(written.contains("\"Widget\""), "the single-file harvest landed in the scratch file: {written}");
        assert!(written.contains("\"count\":1"), "exactly one candidate from the single file: {written}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn harvest_is_in_the_help_catalog() {
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "harvest");
        // `<repo-dir-or-file>` since #3722 made a single FILE a valid target; the needle was never updated.
        for needle in ["<repo-dir-or-file>", "--kit", "--worthy-only", "buildable", "composes", "CLOSURE"] {
            assert!(d.contains(needle), "harvest help mentions {needle}");
        }
    }

    #[test]
    fn harvest_refuses_a_target_outside_the_sessions_confinement_root() {
        // #3475: the designer holds `bsc ui` (so `Bash(bsc ui *)` already matches harvest) but is
        // confined to its studio workspace and cannot `Read` a repo file. Without this gate the verb
        // would hand it every component's source from any path on disk, laundered through the CLI.
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").join("harvest").to_string_lossy().into_owned();
        let elsewhere = std::env::temp_dir().to_string_lossy().into_owned();
        let err = bsc_cli_util::with_repo_root(Some(&elsewhere), || {
            run(vec!["harvest".into(), fixtures.clone()], "bsc ui").unwrap_err()
        });
        assert!(err.contains("outside every root this session may harvest"), "{err}");
        // …and the SAME call inside the session's root still works — this bounds, it does not revoke.
        let own_root = env!("CARGO_MANIFEST_DIR").to_string();
        assert!(
            bsc_cli_util::with_repo_root(Some(&own_root), || run(
                vec!["harvest".into(), fixtures.clone()],
                "bsc ui"
            ))
            .is_ok(),
            "a target inside the root is still harvestable",
        );
        // An unconfined session (no root set) is unchanged.
        assert!(bsc_cli_util::with_repo_root(None, || run(vec!["harvest".into(), fixtures], "bsc ui")).is_ok());
    }

    #[test]
    fn env_command_dispatches_reports_the_harvest_roots_and_is_in_help() {
        // #3571: the read-only discovery verb — Ok in every form; a bad flag errs; and with a granted
        // harvest root it names the exact `bsc ui harvest <root>` the session should run.
        assert!(run(vec!["env".into()], "bsc ui").is_ok());
        assert!(run(vec!["env".into(), "--json".into()], "bsc ui").is_ok());
        assert!(run(vec!["env".into(), "help".into()], "bsc ui").is_ok());
        assert!(run(vec!["env".into(), "--nope".into()], "bsc ui").is_err());
        // The report (pure core in bsc-cli-util) surfaces a granted app-source root as a harvest target.
        let report = bsc_cli_util::with_harvest_roots(Some("C:/src/base-studio-code"), || {
            bsc_cli_util::format_session_env("bsc ui")
        });
        assert!(report.contains("bsc ui harvest C:/src/base-studio-code"), "{report}");
        // It is in the help catalog and points at the harvest verb.
        let d = bsc_cli_util::help_for("bsc ui", TAGLINE, COMMANDS, "env");
        for needle in ["$BSC_HARVEST_ROOTS", "harvest", "--json"] {
            assert!(d.contains(needle), "env help mentions {needle}");
        }
    }

    #[test]
    fn harvest_note_routes_a_const_only_module_to_the_verb_that_can_read_it() {
        // #4161: the const/type module case — `projectsFilter.ts`-shaped, no components, no functions.
        // The whole report was `{"candidates":[],"count":0}` with no next move.
        let note = harvest_note("projectsFilter.ts", 0, 0, true).expect("a fruitless file harvest says why");
        assert!(note.contains("bsc files read"), "names the verb that works: {note}");
        assert!(note.contains("projectsFilter.ts"), "names the target: {note}");

        // Functional modules still route to the algorithms graph — and now ALSO name the const case,
        // which is the half `bsc graph harvest` never covered.
        let f = harvest_note("src/features/planner/list", 7, 0, false).expect("functional modules route");
        assert!(f.contains("bsc graph harvest src/features/planner/list"));
        assert!(f.contains("bsc files read"), "the const/type case is named too: {f}");

        // A harvest that found components needs no routing note.
        assert!(harvest_note("src/shared/ui", 0, 5, false).is_none());
        assert!(harvest_note("Card.tsx", 0, 1, true).is_none());
    }

    #[test]
    fn the_harvest_notes_suggested_command_is_not_the_one_that_returns_nothing() {
        // The regression this issue exists for: #3740's note routed a FILE target to `bsc graph harvest
        // <that file>`, which returned `{"candidates":[],"count":0}` because the dir walk cannot read a
        // file — so the advertised hand-off was a dead end. A file target must never be sent there as
        // its only option; `bsc files read` is always offered alongside.
        for note in [
            harvest_note("projectsFilter.ts", 7, 0, true).unwrap(),
            harvest_note("projectsFilter.ts", 0, 0, true).unwrap(),
        ] {
            assert!(note.contains("bsc files read"), "every fruitless file harvest offers the read verb: {note}");
        }
    }
}
