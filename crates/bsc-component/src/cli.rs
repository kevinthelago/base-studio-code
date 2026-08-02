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

/// The data-shape vocabulary (#2475 + `series` #3517) — the seven canonical shapes a feature's data
/// can take, each with the one-line description `bsc ui shapes` prints. A component's optional `shapes`
/// JSON field stamps the shapes it is an IDEAL rendering for; the CLI computes the index from those
/// fields verbatim (no Rust schema — the store stays verbatim JSON). Mirrors `DataShape` in
/// `src/features/designs/lib/model.ts`.
const DATA_SHAPES: &[(&str, &str)] = &[
    ("list", "a flat, ordered collection of homogeneous items"),
    ("linked-list", "a sequence whose items chain by explicit next/prev links"),
    ("tree", "a hierarchy — every item nests under a single parent"),
    ("graph", "nodes joined by arbitrary edges (many-to-many)"),
    ("table", "homogeneous records with fixed, aligned columns"),
    ("key-value", "one record's named fields — a label → value map"),
    ("series", "an ordered axis + one or more aligned numeric value series — a time-series (LineArea · Bars · Spark)"),
];

const COMPONENT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every component's {id, name, kitId, role, group, shapes} (JSON; --graph for the graph projection)",
        usage: "\
USAGE:
  bsc ui list [--kit <id>] [--shape <shape>] [--graph] [--full] [--pretty] [--raw]

Prints every component's { id, name, kitId, role, group, shapes } as JSON (compact; --pretty for indented).
--shape filters to the components whose `shapes` field stamps <shape> — the kit's IDEAL renderings
for that data shape (#2475/#3517; one of list · linked-list · tree · graph · table · key-value · series — see
`bsc ui shapes`). --full emits the COMPLETE component objects (variants + props + composes + guidance
+ source + …) as a plain array — the full-fidelity read the desktop library hydration needs.
--graph (#4072) emits { id, name, kitId, role, group, used, composes } — EXACTLY what the Design
Studio's composition graph renders: the node card plus the field its edges derive from. It exists
because --full is 1.72 MB over 321 components (77.6% of it `srcText`, which no node reads) and the
page blocked up to 8s on it; the graph projection is 33 KB. Reach for --full only when you need a
component's source/variants/props — and prefer `get <id>` for ONE component over the whole library.
--raw (#3166) drops the JSON entirely and prints ONE id per line, raw UTF-8, LF-only — byte-clean for
`for id in $(bsc ui list --raw)` / `while read id` (no CRLF or cp1252 traps; honors --kit/--shape, ignores --full/--pretty).",
    },
    CmdDoc {
        name: "shapes",
        summary: "the data-shape vocabulary → each shape's ideal components (#2475)",
        usage: "\
USAGE:
  bsc ui shapes [<shape>] [--pretty]

Prints the seven-shape data vocabulary — list · linked-list · tree · graph · table · key-value · series — as a
JSON array of { shape, desc, components }, where components are the stored components whose `shapes`
field stamps that shape (the kit's IDEAL renderings for it, as lean {id, name, kitId, role, group, shapes}
rows). With <shape>, prints just that shape's entry. An EMPTY components array means the kit has no
ideal layout for that shape yet — a genuine gap to record, not a fit to force. Read-only: how the
planner picks a layout — derive the data's shape, then `bsc ui shapes <shape>` (or the equivalent
filter, `bsc ui list --shape <shape>`).",
    },
    CmdDoc {
        name: "get",
        summary: "print one component (JSON, verbatim) or null — or ONE field with --field (#3162)",
        usage: "\
USAGE:
  bsc ui get <id> [--pretty] [--raw] [--out <name>] [--kit <kitId>]
  bsc ui get <id> --field <json-pointer> [--raw] [--pretty] [--out <name>] [--kit <kitId>]

Prints the stored component JSON for <id> verbatim, or `null` if absent. --raw (#3166) writes the
record as raw UTF-8 bytes, LF-only (CR-stripped), no locale layer — safe for `VALUE=$(bsc ui get <id>
--raw)`; a missing id prints NOTHING (empty capture) rather than the literal `null`. With --field
(#3162), prints just the value at the RFC-6901 JSON pointer <json-pointer> (e.g. `/name`, `/props/0/req`,
`/srcText`; a leading `/` is optional) — errors when the component OR the field is absent; --raw unwraps
a string value (no quotes/escaping) via the SAME raw printer, so a shell `$(...)` capture is clean (a
non-string value prints as compact JSON), and without --raw the value prints as JSON (--pretty indents).

--out <name> (#3713) writes the SAME bytes to a BARE-named file in the session's $BSC_SCRATCH dir instead
of stdout, then prints that path. Use it to review a LARGE value (e.g. a big `srcText`) a restricted
session would otherwise truncate on stdout — the scratch file is a confinement-allowed path, so Read/Grep
open it in full. <name> must be bare (no '/', '\\', '..' or ':') and $BSC_SCRATCH must be set. With --out,
a missing id/field ERRORS (there is nothing to write) rather than emitting an empty capture.

--kit <kitId> (#3729) DISAMBIGUATES — the store is keyed by id ALONE, so there is exactly one record per
id; this asserts WHICH kit it belongs to, erroring (naming the actual kit) on a mismatch. Note: writing a
component whose id already lives under another kit OVERWRITES it — `bsc ui set` now warns about that.",
    },
    CmdDoc {
        name: "log",
        summary: "a record's change history — the current stamp + the per-write log (#3164/#3568)",
        usage: "\
USAGE:
  bsc ui log <id> [--kit] [--dir D] [--pretty]

Prints the record's provenance AND its change history as JSON —
{ id, rev, updatedAt, updatedBy, history: [ { rev, at, by, note?, changed } ] }. The top-level fields are
the current stamp (#3164): `rev` is the monotonically-increasing revision (a record never stamped, or a
legacy one, reads as rev 0); `updatedAt` is the last write's ISO-8601 UTC timestamp; `updatedBy` is the
writer tag (`bsc ui set --by <tag>` / $BSC_UI_WRITER, else \"unknown\"). `history` (#3568) is the per-write
log, NEWEST-FIRST, one entry per write: its `rev`, `at` (ISO-8601), `by` (the writer), an optional `note`
(`bsc ui set --note <text>`), and `changed` (the top-level fields that moved, `[\"created\"]` on the first
write). Capped to the most recent 30 writes. Review it before editing so you know what changed and why.
--kit logs a KIT record instead of a component. Read-only. Use the `rev` to guard your next write:
`bsc ui set --if-version <rev>` refuses to overwrite if the record has moved on.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from component JSON on stdin (stamps rev/updatedAt/updatedBy); prints id(s)",
        usage: "\
USAGE:
  bsc ui set [--by <tag>] [--note <text>] [--if-version <n>] [--pretty]   # component JSON (one object or an array) on stdin
  bsc ui set --file <name> [--by <tag>] [--note <text>] [--pretty]        # ...or the same JSON from $BSC_SCRATCH/<name>

Upserts each component by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written — how an agent (or the pane) authors/updates a component in the shared kit.

--file <name> reads the SAME payload from a bare-named file in the session's $BSC_SCRATCH dir instead
of stdin (#3373). It exists because a heredoc cannot be permitted in a restricted session: newlines are
command separators, so the JSON body parses as its own (unmatchable) subcommands. The name must be
BARE — no '/', '\\', '..' or ':' — and $BSC_SCRATCH must be set, or the flag is refused.

Every write STAMPS provenance (#3164): it auto-bumps the record's `rev` integer, sets `updatedAt`
(ISO-8601 UTC), and records `updatedBy` — the writer tag from `--by <tag>`, else $BSC_UI_WRITER, else
\"unknown\". --if-version <n> is OPTIMISTIC CONCURRENCY: the write is REJECTED (non-zero exit, nothing
stored) unless the record's CURRENT rev is exactly <n> — so a background rewrite can't silently clobber
your edit. Read a record's current rev with `bsc ui log <id>`; --if-version takes a single record on stdin.

An optional `group` field is the component's FOLDER PATH within the kit — a nested, `/`-delimited path
(`shared/ui/controls`, `features/github`) that organizes the kit like a completed project's folders
(#3579). Orthogonal to `role` (the arch tier), organizational only (`composes` still resolves across the
whole kit). `bsc ui refolder` re-derives it from `src` for the whole store; the harvest seeds it too.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a component (no-op if absent)",
        usage: "\
USAGE:
  bsc ui remove <id> [--pretty]

Deletes the component keyed by <id>. A no-op (not an error) when it does not exist. NOTE: a PACKAGED
BUILTIN comes back on the next hydrate (the seed re-adds it) — use `suppress` to remove it permanently.",
    },
    CmdDoc {
        name: "suppress",
        summary: "PERMANENTLY remove a packaged builtin component — it won't re-seed (#3725)",
        usage: "\
USAGE:
  bsc ui suppress <id> [--pretty]

Writes a `{ id, suppressed: true }` TOMBSTONE for <id>, so the frontend seed-reconcile stops re-adding
the packaged builtin (a plain `remove` re-seeds on the next hydrate). The library and the doctor both
skip a tombstone. Use for a builtin you never want back; `unsuppress` restores it (re-seeds from source).
A ui-scope MUTATION.",
    },
    CmdDoc {
        name: "unsuppress",
        summary: "remove a suppression tombstone so the builtin re-seeds (#3725)",
        usage: "\
USAGE:
  bsc ui unsuppress <id> [--pretty]

Removes the `{ id, suppressed: true }` tombstone written by `suppress`, so the next hydrate re-seeds the
packaged builtin from its source. Errors if <id> is NOT a tombstone (use `remove` for a real component).
A ui-scope MUTATION.",
    },
    CmdDoc {
        name: "export",
        summary: "dump every component to a folder tree — <dir>/<group>/<id>.json, lossless (#3606)",
        usage: "\
USAGE:
  bsc ui export <dir> [--dir <store>] [--pretty]

Writes each stored component VERBATIM to <dir>/<group>/<id>.json, nesting by its `group` folder path
(#3579) so the tree mirrors a project's folders. The seed half of components-as-data: round-trips
through `bsc ui import`. Files are written pretty (readable diffs); --pretty also indents the report.
A READ — no `ui` write scope required. `--dir` overrides the STORE location, not the output <dir>.",
    },
    CmdDoc {
        name: "import",
        summary: "load a folder tree of component records into the store — the seed half (#3606)",
        usage: "\
USAGE:
  bsc ui import <dir> [--dir <store>] [--pretty]

Walks <dir> recursively for *.json and UPSERTS each into the store, keyed by the record's own `id`. A
file that is a KIT BUNDLE ({\"components\":[…]}, e.g. react-ui.json) is exploded — every component in it
is imported. A missing <dir> is empty, not an error. A ui-scope MUTATION. The load half that pairs
with `bsc ui export`; boot-seeding imports the packaged `data/components/` tree the same way.",
    },
    CmdDoc {
        name: "rename",
        summary: "rename a component in place — sweeps every composes/rules reference (#3576)",
        usage: "\
USAGE:
  bsc ui rename <id> <NewName> [--by <tag>] [--note <text>] [--dir D] [--pretty]

Renames the component keyed by <id> to <NewName> in ONE operation. <id> is the STABLE store key (frozen at
creation, never re-derived), so only the display/code NAME moves — nothing keyed by id (the store key, the
change history #3164/#3568, tokens, the cross-graph URN) is disturbed.

Because the composition graph is NAME-keyed, a rename rewrites, scoped to the component's OWN kit (kits
never cross):
  • the record's `name`, and the identifier in its `srcText` (+ `source` if present) — `export function
    <Old>` and self-`<Old>` → `<New>`, matched on whole-identifier boundaries so `IconButton` /
    `ButtonGroup` are never touched;
  • every sibling's `composes[]` entry == <Old>, and every `rules[].use` == <Old>, → <New>.

Every touched record gets a change-history entry (#3568); `--note` overrides the default
\"renamed <Old> → <New>\" summary. Prints { id, from, to, kit, updated: [ids], referencesUpdated }.

REFUSES when <NewName> is not a PascalCase identifier, equals the current name, or already names another
component in the same kit (which would make `composes` ambiguous). A ui-scope MUTATION.",
    },
    CmdDoc {
        name: "merge",
        summary: "combine a duplicate INTO a survivor — repoints every reference, then removes it (#3592)",
        usage: "\
USAGE:
  bsc ui merge <from-id> <into-id> [--by <tag>] [--note <text>] [--dir D] [--pretty]

Folds the component `<from-id>` INTO `<into-id>` (the survivor) in ONE operation — the ACT step that closes
the `dupes`/`similar` loop (which only PROPOSE). `<into>` stays authoritative (its own name, srcText,
props); `<from>` is removed and everything that referenced it now references `<into>`. Scoped to the kit —
`composes` is name-keyed and kits never cross, so a cross-kit merge is refused.

Repoints, across the survivor's kit:
  • every component's `composes[]` entry == <from>'s name → <into>'s name (deduped; a self-reference the
    fold would create — e.g. <into> composed <from> — is dropped, never a component composing itself);
  • every `rules[].use` == <from>'s name → <into>'s name.
Then DELETES the `<from>` record. Every repointed record gets a change-history entry (#3568); `--note`
overrides the default \"merged <from> → <into>\" summary. Prints { from, into, kit, repointed: [ids], removed }.

Pair with `bsc ui used-by`: merge the LESS-used component into the more-used one. REFUSES when either id is
absent, they are the same, or they live in different kits. A ui-scope MUTATION.",
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
        name: "backing",
        summary: "which component record backs a file — and the gate that keeps edits going to the record",
        usage: "USAGE:
  bsc ui backing <path> [--json|--pretty]   # the record(s) whose `src` names this file
  bsc ui backing gate <path>...             # exit 1 if ANY path is record-backed (the landing gate)

The graph is the source of truth and a component's file is the EMITTED ARTIFACT, so a fix belongs in the
record: edit it with `bsc ui set`, then `bsc ui emit component <id> <dir>` and the file follows. Editing
the file directly loses the change — the record keeps the old body and the app renders the record (#4193).

`backing <path>` answers whether a file has a record before you touch it. It reads the store's own `src`
provenance, so it covers EVERY component, not only the pages in the migration catalogue. Prints
`{ path, backed, records: [{ id, kitId, src }] }`.

`backing gate <path>...` is the landing check: run it over the files your change touches (e.g.
`git diff --name-only`). It exits 1 and names the record + the two fix commands for every backed path, and
exits 0 when none are backed. Rejecting rather than warning is deliberate — a warning here becomes noise.

SCOPE: components only. An algorithm record is a function LIFTED OUT of a file and several share one
`src` (#4192), so a path-based gate cannot be honest about them yet.",
    },
    CmdDoc {
        name: "doctor",
        summary: "graph-health report — orphans, dead branches, duplicates, cycles, unbuildable + self-referential components (#2678)",
        usage: "\
USAGE:
  bsc ui doctor [--kit K] [--json] [--pretty]     # the health report (read-only)
  bsc ui doctor --sound-kit id@version [--json]   # judge @bsc/sounds/… against a PINNED sound kit (#3412)
  bsc ui doctor --motion [--kit K] [--json]       # ALSO run the four mechanical MOTION checks (#3163)
  bsc ui doctor --fix [--kit K] [--yes]           # OPTIMIZE: merge byte-identical dups + prune dead roots (dry-run unless --yes)

--sound-kit (#3412) names the project's PINNED sound kit (its blueprint's `soundKit`, as `id@version` in the
`bsc sound release` store), so a `@bsc/sounds/<cue>` reference is judged against the kit the project actually
adopted — the same target the Design Studio's preview resolves. Omit it for an unpinned project and the
packaged default kit is used. A ref the store does not hold is a hard ERROR, never a quiet fall back to the
default: a pinned project reported against the starter kit would call broken sound references clean.

--motion (#3163) ADDS four mechanical animation checks to the report: MOTION-DEAD-SELECTOR (an animation
`selector` whose class hook the component's source never renders — it matches nothing), MOTION-DASH-NO-
PATHLENGTH (a stroke-dash(offset|array) keyframe on a component that sets no `pathLength` — a draw needs a
known path length), MOTION-TRANSFORM-ATTR (a CSS `transform` keyframe on a component using an SVG
`transform=` ATTRIBUTE — the two don't compose), and MOTION-NAME-COLLISION (an inline animation NAME
declared by 2+ components in the same kit — their keyframes clobber). They scan each component's INLINE
animation defs (a name-ref string points at the kit's shared library and is not checked).

Traverses each kit's composition graph (nodes = components, edges = `composes`) and reports the
dead/duplicated design a growing kit accumulates: CYCLE (a composes loop), DANGLING-BRANCH (an unused
root that still pulls in dependencies), DUPLICATE (two components wrapping the same intrinsic, or
byte-identical source), NO-IMPLEMENTATION (a component the Design Studio preview can't build — a spec,
not code; a built-in whose real source lives in the packaged artifact is NOT flagged), and ORPHAN (an
isolated, never-referenced primitive/composite). \"Unused\" = no composer AND used = 0; a page/layout
with used > 0 is a legit entry point, never flagged. Ranked most-severe-first; --kit scopes to one
kit; --json emits the findings array (LLM-consumable).

--fix is the mechanical, SAFE OPTIMIZE (#3089): (1) MERGE byte-identical-source duplicates — fold each
group into the most-`used` canonical and repoint composers to it (lossless; only byte-identical, never a
same-`wraps` dup), then (2) PRUNE the GUARDED dead roots — the ROOT of each orphan/dangling-branch finding
(never a used > 0 node). DRY RUN by default (prints what WOULD change); pass --yes to apply. Cycles and
same-`wraps` (differing-source) duplicates are NOT auto-resolved — they need a semantic call. Branch
descendants are left for the next pass (one might be shared) — re-run to clean them.

The PRUNE GUARDS (#3087) — the dead-root heuristic is a good REPORT and a dangerous auto-DELETE, so three
classes of candidate are named, then held back: a `page` (a page is a root BY DEFINITION — nothing composes
a page, so the heuristic condemns the whole pages tier), a `builtin: true` packaged seed (shipped on
purpose; the seed reconcile re-adds it), and EVERY candidate while the usage index is unpopulated (no
component in scope carries used > 0, so `used = 0` means UNKNOWN, not unused). A held-back candidate is
still REPORTED by `bsc ui doctor` — only the automatic removal is withheld. #2678/#2679/#3089/#3087.",
    },
    CmdDoc {
        name: "dupes",
        summary: "the whole-library duplicate report — exact + fuzzy NEAR-duplicates (name + contract distance), propose-only (#3544)",
        usage: "\
USAGE:
  bsc ui dupes [--kit K] [--threshold 0..1] [--explain] [--json] [--pretty]

The DEDUP surface. Reports the EXACT `duplicate` findings the per-kit analyzer emits (two components sharing
a `wraps` intrinsic, or byte-identical source) PLUS the FUZZY near-duplicates it structurally misses —
`Donut`≈`DonutChart`, `Bars`≈`BarChart`, `Legend`≈`ChartLegend`, and cross-kit `Card`/`Grid`/`KeyValueList`
repeats a growing multi-kit library accumulates. Each near-duplicate is scored by NAME distance (normalized
token-set + edit distance; `Chart`/`View`/`Bsc` affixes stripped, names singularized) and CONTRACT/body
distance, combined 0.5·name + 0.5·contract. Cross-kit by design — the whole point is consolidating
overlapping kits into one.

CONTRACT TERMS (#4138): prop-signature · source shingles · `src` (same file — a strong PRIOR, not a verdict:
several components are legitimately extracted from one module) · `folder` · `composes` · `shapes` ·
`whenUse`/`whenNot` guidance · variants · tags · colocated `tests` · `wraps` · role. A term with NO signal on
either side is DROPPED, never scored 0 — two prop-less primitives must not read as identical for both
lacking props.

A pair is contract-scored when its NAME is near OR it shares a hard co-location signal (same `src`, folder,
`wraps`, `provides`, shape or test file). Before #4138 a dissimilar name alone skipped the pair entirely, so
`Donut` vs `PieChart` — the duplicates you cannot grep for — were invisible unless byte-identical.

Also reports `provides-collision`: several records overriding ONE platform specifier. Not a similarity
score — the loader resolves it to one record, so the rest are dead overrides that still read as live.

--explain prints each pair's per-term contributions (`term=value×weight→contribution`) and the terms dropped
for lack of signal, so the ranking is auditable and the weights are tunable against real output.

--threshold tunes the fuzzy bar (default 0.55); --kit scopes to ONE kit (which drops cross-kit near-dups);
--json emits the findings array (LLM-consumable), each `{ category, severity, kit, nodeIds, nodeNames, why,
suggestedAction }`. PROPOSE-ONLY: there is no `--fix` here — a near-duplicate is a WEAKER signal than a
byte-identical dup and the merge is a semantic call, so use these proposals to guide a manual/designer merge.
Inspect one component's neighborhood with `bsc ui similar <id>`. #3544.",
    },
    CmdDoc {
        name: "similar",
        summary: "components most similar to <id> across the whole library (name + contract distance) — discover-before-authoring (#3544)",
        usage: "\
USAGE:
  bsc ui similar <id> [--top N] [--threshold 0..1] [--json] [--pretty]

Ranks every OTHER component by its similarity to <id> (the same name + contract distance `bsc ui dupes`
uses), most-similar first. The discover-before-authoring read: BEFORE a session authors a new component it
asks whether one like it already exists, so the library converges instead of sprouting a fourth `Card`.
Cross-kit. --top caps the rows (default 10); --threshold sets a minimum overall score (default 0 — the
internal name gate already drops unrelated names). --json emits `[{ id, name, kit, score, name_similarity,
contract_similarity, usedBy }]` — `usedBy` is the candidate's graph-usage (#3584), so a combine proposal
carries which side is load-bearing. PROPOSE-ONLY — reads only. #3544.",
    },
    CmdDoc {
        name: "used-by",
        summary: "a component's REAL graph usage — how many kit components compose it (composes-inverse, #3584)",
        usage: "\
USAGE:
  bsc ui used-by <id> [--json] [--pretty]           # one component: its composers + count
  bsc ui used-by --all [--kit K] [--json] [--pretty] # every component, ranked by usage (most-used first)

The USAGE read the optimizer needs before combining. `usedBy` = how many components in the SAME kit list
this one in `composes` (kits never cross, so a composer must share the kit) — the composes-INVERSE. Unlike
the `used` field (a codebase-usage placeholder that is unpopulated for real components), this is computed
live from the graph, is never a placeholder, and is the right signal for optimizing THIS graph: a primitive
composed by 9 is load-bearing; one at 0 is an orphan candidate. Pair it with `bsc ui similar` / `dupes`: find
overlap, then fold the LESS-used component into the more-used one.

<id> form prints { id, name, kit, usedBy: [composer names], count }. --all prints every component as
{ id, name, kit, count }, most-used first (--kit scopes to one kit). A READ — never scope-gated.",
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
    CmdDoc {
        name: "set-src",
        summary: "replace ONLY a component's srcText from stdin (gated by the JSX syntax check) (#3162)",
        usage: "\
USAGE:
  bsc ui set-src <id>   # the new srcText on stdin (raw text, not JSON)

Replaces JUST the `srcText` field of component <id> with stdin, leaving every other field untouched — the
granular write that avoids a whole-record round-trip (and its ~10KB stdin ceiling) for a one-field source
edit. The new source passes the SAME write-time JSX syntax gate as `bsc ui set` (#2928): a module
`srcText` that won't build (e.g. an unterminated string) is REJECTED before anything is written. Errors
when the component is absent (author it first with `bsc ui set`). A ui-scope MUTATION (#2470).",
    },
    CmdDoc {
        name: "patch",
        summary: "set ONE field of a component by JSON pointer; value parsed as JSON (#3162)",
        usage: "\
USAGE:
  bsc ui patch <id> <json-pointer> <value>

Sets a single field of component <id> at the RFC-6901 JSON pointer <json-pointer> (e.g. `/name`,
`/props/0/req`; a leading `/` is optional), leaving every other field untouched — the granular write for
a one-field edit. <value> is parsed as JSON (so `true`, `42`, `[1,2]`, `\"text\"` keep their type),
falling back to a bare string when it is not valid JSON. The pointer's PARENT container must already
exist (an array index may equal the length to append, or `-` to push). The patched record still passes
the `bsc ui set` JSX syntax gate (#2928). Errors when the component or the pointer's parent is absent. A
ui-scope MUTATION (#2470).",
    },
    CmdDoc {
        name: "refolder",
        summary: "re-derive every component's `group` as a folder path from its `src` (#3579)",
        usage: "\
USAGE:
  bsc ui refolder [--kit <id>] [--dry-run] [--pretty]    # (`regroup` is a deprecated alias)

Re-derives each stored component's `group` as a nested, `/`-delimited FOLDER PATH from its `src`
(`src/shared/ui/controls/Button.tsx` → `shared/ui/controls`; a leading `src/` root is stripped, the
filename dropped), so a kit organizes like a completed project's folders instead of ad-hoc flat buckets.
Rewrites ONLY the records whose derived group differs — each write is stamped + logged (`bsc ui log`) —
and leaves a component with no usable `src` untouched. --kit scopes the pass to one kit; --dry-run
reports the moves without writing. Prints { scanned, changed: [{ id, from, to }], applied }. A ui-scope
MUTATION (#2470).",
    },
    CmdDoc {
        name: "preview-props",
        summary: "the schema-derived sample props the live preview passes a component, per state (#3165)",
        usage: "\
USAGE:
  bsc ui preview-props <id> [--state loaded|empty|loading] [--dir D] [--pretty]

Prints EXACTLY the props the Design Studio's build-and-iframe preview harness passes <id>'s component,
for each data-state: { id, name, role, states: { loaded, empty, loading } }, each state
{ props: [{ name, value }], child }. Every `value` is a JS-SOURCE literal/expression the iframe
evaluates (e.g. `() => {}`, `window.innerWidth`, `Math.min(window.innerWidth, window.innerHeight)`, or a
JSON-string like \"var(--accent)\") — NOT a JSON value — so a schema-derived sample that renders wrong
(black bars, a NaN-collapsed chart) is inspectable from the shell. `child` is the element child text (or
null). Mirrors the TS sampler (samplePropValue/bootstrapSource, componentPreview.ts); a shared parity
fixture pins the two. --state narrows to one state. Read-only; errors when <id> is absent.",
    },
    CmdDoc {
        name: "preview-errors",
        summary: "tail the live preview's captured runtime errors (#3165)",
        usage: "\
USAGE:
  bsc ui preview-errors [-n N] [--pretty]

Prints the last N (default 20) preview runtime errors the Design Studio captured — the sandboxed
iframe's throws + unhandled rejections the live preview would otherwise only show in-pane. Each record
is { at, id, message } (a multi-line stack trace rides safely on one JSON line). Default compact JSON;
--pretty indents. This is the durable, tail-able side of `bsc ui preview-error` (the frontend appends a
record when a preview throws), so a preview runtime failure is observable from a session's shell. Read-only.",
    },
    CmdDoc {
        name: "preview-error",
        summary: "record a preview runtime error — the frontend's durable append path (#3165)",
        usage: "\
USAGE:
  bsc ui preview-error <id>         # the error message / stack trace on stdin
  bsc ui preview-error clear <id>   # clear a STALE error (#3737)

Appends one { at, id, message } record (message read from stdin) to the preview-error log
(~/.base-studio-code/preview-errors.log, or $BSC_PREVIEW_ERROR_LOG), capped to the most recent 200. The
Design Studio's live preview calls this when the sandboxed iframe posts `{__preview:\"error\"}`, so the
throw becomes durable + tail-able via `bsc ui preview-errors`. A diagnostic append (not a store
mutation), so it is not ui-scope gated. Prints the recorded id.

`clear <id>` (#3737) drops the current error for <id> — for when the recorded throw no longer reflects the
component's source (editing it via `set`/`set-src`/`patch` now clears automatically; this is the manual
lever). A no-op when the id has no current error.",
    },
];

const KIT_COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every kit's {id, name, stack} (JSON)",
        usage: "\
USAGE:
  bsc ui kit list [--full] [--pretty] [--raw]

Every kit's { id, name, stack } as JSON (compact; --pretty for indented). --full emits the complete
kit objects (incl. the dot color) as a plain array. --raw (#3166) prints ONE kit id per line, raw
UTF-8, LF-only — byte-clean for `while read id` / `$( )`.",
    },
    CmdDoc {
        name: "get",
        summary: "print one kit (JSON, verbatim) or null",
        usage: "USAGE:\n  bsc ui kit get <id> [--pretty] [--raw]\n\nThe stored kit JSON for <id> verbatim, or `null` if absent. --raw (#3166) writes the record as raw UTF-8 bytes, LF-only, no locale layer — safe for `$( )` capture; a miss prints nothing.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from kit JSON on stdin (stamps rev/updatedAt/updatedBy); prints id(s)",
        usage: "USAGE:\n  bsc ui kit set [--by <tag>] [--note <text>] [--if-version <n>] [--pretty]   # kit JSON (object or array) on stdin\n  bsc ui kit set --file <name> [--by <tag>] [--note <text>] [--pretty]        # ...or the same JSON from $BSC_SCRATCH/<name> (#3373)\n\nUpserts each kit by its \"id\", written verbatim. Fields: { id, name, tech, style, stack?, dot } — tech + style place the kit in the rail (omit either ⇒ it shows as \"other/other\"); stack is a display label only. Every write stamps provenance (#3164): auto-bump `rev`, set `updatedAt` (ISO-8601 UTC) + `updatedBy` (--by / $BSC_UI_WRITER / \"unknown\"), and appends a change-history entry (#3568: --note is its summary; `bsc ui log <id> --kit` reads it). --if-version <n> rejects the write unless the kit's current rev is <n>.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "USAGE:\n  bsc ui kit remove <id> [--pretty]\n\nDeletes the kit keyed by <id>; a no-op when absent. NOTE: a PACKAGED BUILTIN kit re-seeds on the next hydrate — use `bsc ui kit suppress` to remove it permanently.",
    },
    CmdDoc {
        name: "suppress",
        summary: "PERMANENTLY remove a packaged builtin kit — it won't re-seed (#3725)",
        usage: "USAGE:\n  bsc ui kit suppress <id> [--pretty]\n\nWrites a `{ id, suppressed: true }` tombstone for the kit <id>, so the seed-reconcile stops re-adding the packaged builtin (a plain `kit remove` re-seeds it). `bsc ui kit unsuppress` restores it. A ui-scope MUTATION.",
    },
    CmdDoc {
        name: "unsuppress",
        summary: "remove a kit suppression tombstone so the builtin re-seeds (#3725)",
        usage: "USAGE:\n  bsc ui kit unsuppress <id> [--pretty]\n\nRemoves the tombstone written by `kit suppress`, so the next hydrate re-seeds the packaged builtin kit. Errors if <id> is not a tombstone. A ui-scope MUTATION.",
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
        name: "emit-motion-css",
        summary: "print the COMPILED motion CSS — keyframes + rules + delays (make the motion inspectable, #3163)",
        usage: "\
USAGE:
  bsc ui kit emit-motion-css [--kit K]

Compiles the authored motion to the SAME CSS the render-preview plays and prints it — the `@keyframes`
blocks + the `prefers-reduced-motion`-guarded applying rules (with any `set` declarations, `delay`, and the
per-element stagger ramp) — so an author can SEE the motion instead of guessing from the data. Covers BOTH
the KIT motion libraries (`@keyframes bsc-<kit>-<name>` on `.<kit>-anim-<name>`) and each component's INLINE
animations, the latter NAMESPACED by their owning component (`bsc-<kit>-<component>-<name>`, #3163) so two
components' same-named animations don't collide. --kit scopes to one kit (else every kit). Read-only; the
same closed safety grammar as `define-animation` — an unsafe def is skipped, never emitted.",
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
    meta_fields: &["id", "name", "kitId", "role", "folder", "shapes"],
    // #4072 — exactly what the Design Studio's composition graph renders: the node card
    // (name/role/group/×used) plus `composes`, which `buildComposesEdges` turns into the edges.
    // Deliberately NOT `srcText` (77.6% of the full payload) / `tests` / `history` / `props`: the
    // graph reads none of them, and the page was blocking up to 8s fetching them.
    graph_fields: &["id", "name", "kitId", "role", "folder", "used", "composes"],
    // #4107 slice B: `group` -> `folder`. 351 stored records predate the rename and there is no
    // migration pass, so every projection reads the legacy key when the current one is absent.
    field_aliases: &[("folder", "group")],
};

/// The kit collection's knobs. Lean `list` projects id/name/tech/style/stack.
const KIT_SPEC: CliSpec = CliSpec {
    noun: "kit",
    dir_env: "BSC_COMPONENT_KIT_DIR",
    dir_segment: "kits",
    tagline: KIT_TAGLINE,
    commands: KIT_COMMANDS,
    meta_fields: &["id", "name", "tech", "style", "stack"],
    graph_fields: &[],
    field_aliases: &[],
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
        Some("set") | Some("remove") | Some("rename") | Some("merge") | Some("define-animation") | Some("remove-animation") | Some("refolder") | Some("regroup") | Some("import") | Some("suppress") | Some("unsuppress")
    ) && next.map(String::as_str) != Some("help")
}

/// `bsc ui suppress <id>` / `bsc ui kit suppress <id>` (#3725) — write a `{ id, suppressed: true }`
/// TOMBSTONE into the collection's store, PERMANENTLY removing a packaged builtin: the frontend
/// `reconcileSeed` sees the tombstone occupying the id and never re-seeds the builtin (a plain `remove`
/// comes back on the next hydrate). A ui-scope MUTATION (gated by [`is_scoped_mutation`] before this runs).
fn cmd_suppress(
    args: &[String],
    open: impl Fn(&Option<String>) -> Result<bsc_json_store::Store, String>,
    noun: &str,
) -> Result<(), String> {
    let kit_prefix = if noun == "kit" { "kit " } else { "" };
    let (pos, dir, _pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or_else(|| format!("usage: bsc ui {kit_prefix}suppress <id>"))?;
    let store = open(&dir)?;
    let tombstone = serde_json::json!({ "id": id, "suppressed": true });
    stamped_set(&store, id, tombstone, &crate::record::resolve_writer(None))?;
    // A suppressed component carries no live preview — clear any stale render-error keyed to it (#3707).
    if noun == "component" {
        let _ = crate::preview_errors::clear(id);
    }
    println!("suppressed {noun} '{id}' — the packaged builtin will not re-seed (`unsuppress` to restore)");
    Ok(())
}

/// `bsc ui unsuppress <id>` / `bsc ui kit unsuppress <id>` (#3725) — remove a suppression tombstone so the
/// next hydrate re-seeds the packaged builtin from its source (no data loss). REFUSES on a non-tombstone
/// id: a real record must go through `remove`, never this.
fn cmd_unsuppress(
    args: &[String],
    open: impl Fn(&Option<String>) -> Result<bsc_json_store::Store, String>,
    noun: &str,
) -> Result<(), String> {
    let kit_prefix = if noun == "kit" { "kit " } else { "" };
    let (pos, dir, _pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or_else(|| format!("usage: bsc ui {kit_prefix}unsuppress <id>"))?;
    let store = open(&dir)?;
    let existing = current_record(&store, id)?;
    if existing.get("suppressed").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(format!(
            "'{id}' is not a suppression tombstone — nothing to unsuppress (use `remove` to delete a real {noun})"
        ));
    }
    store.remove(id)?;
    println!("unsuppressed {noun} '{id}' — it re-seeds on the next hydrate");
    Ok(())
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
                // #3163: the COMPILED-motion emitter — a custom read over the kit + component stores.
                Some("emit-motion-css") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_emit_motion_css(&args[2..])
                }
                Some(v @ ("define-animation" | "list-animations" | "remove-animation" | "emit-motion-css")) => {
                    print!("{}", bsc_cli_util::help_for(&kit_prog, TAGLINE, KIT_COMMANDS, v));
                    Ok(())
                }
                // `kit set` is intercepted here (#3164) so it stamps rev/updatedAt/updatedBy + honors
                // --by/--if-version — the shared store CLI's parser would reject those flags and never
                // stamps. `kit set help`, `kit list/get/remove` still fall through to the shared CLI
                // below (which fires the "kit" ui-touch on remove). Already ui-scope gated above.
                Some("set") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_set(&args[2..], open_kit_store, warn_kit_axes, "kit")
                }
                // #3725: permanently remove a packaged builtin KIT (its shell survives a plain `kit
                // remove`, re-seeded on hydrate). ui-scope gated above (the `kit` prefix → args[1] check).
                Some("suppress") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_suppress(&args[2..], open_kit_store, "kit")
                }
                Some("unsuppress") if args.get(2).map(String::as_str) != Some("help") => {
                    cmd_unsuppress(&args[2..], open_kit_store, "kit")
                }
                Some(v @ ("suppress" | "unsuppress")) => {
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
        // `backing` (#4193) — which record backs a file, and the landing gate built on it.
        Some("backing") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "backing"));
                Ok(())
            } else {
                cmd_backing(&args[1..])
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
        // `dupes` / `similar` (#3544) — the fuzzy DEDUP surface over the whole library (name + contract
        // distance), the LLM-native "what should I merge?" / "does this already exist?" reads. Propose-only.
        Some("dupes") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "dupes"));
                Ok(())
            } else {
                cmd_dupes(&args[1..])
            }
        }
        Some("similar") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "similar"));
                Ok(())
            } else {
                cmd_similar(&args[1..])
            }
        }
        // `used-by` (#3584) — the graph-usage read (composes-inverse); a READ, never scope-gated.
        Some("used-by") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "used-by"));
                Ok(())
            } else {
                cmd_used_by(&args[1..])
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
        // `preview-props` (#3165) — the preview harness's schema-derived sample props for <id>, per
        // data-state. A custom read (pure sampler in `crate::preview_props` mirrors the TS twin).
        Some("preview-props") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "preview-props"));
                Ok(())
            } else {
                cmd_preview_props(&args[1..])
            }
        }
        // `preview-errors` (#3165) — tail the captured preview runtime errors (read).
        Some("preview-errors") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "preview-errors"));
                Ok(())
            } else {
                cmd_preview_errors(&args[1..])
            }
        }
        // `preview-error <id>` (#3165) — the frontend's append path (message on stdin). A diagnostic
        // append, NOT a store mutation, so it is intentionally NOT ui-scope gated.
        Some("preview-error") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "preview-error"));
                Ok(())
            } else {
                cmd_preview_error(&args[1..])
            }
        }
        // The granular writes (#3162): a one-field edit that skips the whole-record stdin round-trip.
        // `set-src` (replace only `srcText`, through the same #2928 syntax gate) and `patch` (set one
        // field by JSON pointer) are ui-scope MUTATIONS — each honors the runtime `ui` write-scope
        // BEFORE touching stdin/the store (in its own fn, like `doctor --fix`), and stamps the write
        // (#3164) via the shared `stamped_set` boundary.
        Some("set-src") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "set-src"));
                Ok(())
            } else {
                cmd_set_src(&args[1..])
            }
        }
        Some("patch") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "patch"));
                Ok(())
            } else {
                cmd_patch(&args[1..])
            }
        }
        // `regroup` (#3579) re-derives every stored component's `group` as a nested folder path from its
        // `src` — a ui-scope MUTATION (gated above), so a kit organizes like a completed project's
        // folders. `regroup help` prints the doc; the scope gate already refused a read-scoped session.
        // `regroup` stays a DEPRECATED ALIAS: the verb is named in prose the designer/librarian may
        // have memorised, and an unknown-command error is a worse migration than one extra match arm.
        Some("refolder" | "regroup") if args.get(1).map(String::as_str) != Some("help") => cmd_refolder(&args[1..]),
        Some("refolder" | "regroup") => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "regroup"));
            Ok(())
        }
        // `export`/`import` (#3606) — components-as-data round-trip: dump the store to a folder tree under
        // `data/` and load it back. `export` is a read; `import` is a ui-scope MUTATION (gated above).
        Some("export") if args.get(1).map(String::as_str) != Some("help") => cmd_export(&args[1..]),
        Some("import") if args.get(1).map(String::as_str) != Some("help") => cmd_import(&args[1..]),
        Some(v @ ("export" | "import")) => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, v));
            Ok(())
        }
        // `get --field <json-pointer>` (#3162, ONE field), `get … --out <name>` (#3713, spill to the
        // scratch dir), OR `get … --kit <kitId>` (#3729, disambiguate) — all intercepted here (the shared
        // store CLI rejects the extra flags), and handled by `cmd_get` (which also emits the whole-record
        // `ui-focus` the plain path does). A plain `get <id>` (incl. the whole-record `--raw`, #3166) still
        // delegates unchanged. A read verb.
        Some("get") if args.iter().any(|a| a == "--field" || a == "--out" || a == "--kit") => cmd_get(&args[1..]),
        // `log` (#3164) is a custom read — the record's history stamp (rev/updatedAt/updatedBy).
        Some("log") => {
            if args.get(1).map(String::as_str) == Some("help") {
                print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "log"));
                Ok(())
            } else {
                cmd_log(&args[1..])
            }
        }
        // `set` (#3164) is intercepted here — it stamps rev/updatedAt/updatedBy + honors --by/--if-version
        // (the shared store CLI never stamps and its parser rejects those flags). `set help` still prints
        // the doc. The scope gate above already refused a read-scoped session before we got here.
        Some("set") if args.get(1).map(String::as_str) != Some("help") => {
            cmd_set(&args[1..], open_component_store, validate_component_batch, "component")
        }
        Some("set") => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "set"));
            Ok(())
        }
        // `rename` (#3576) — id-stable rename that sweeps the NAME-keyed composes/rules references across
        // the kit + stamps history. The scope gate above already refused a read-scoped session.
        Some("rename") if args.get(1).map(String::as_str) != Some("help") => cmd_rename(&args[1..]),
        Some("rename") => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "rename"));
            Ok(())
        }
        // `merge` (#3592) — fold a duplicate INTO a survivor, repointing the NAME-keyed composes/rules
        // references then removing it. The ACT step of the optimize loop. Scope gate above applies.
        Some("merge") if args.get(1).map(String::as_str) != Some("help") => cmd_merge(&args[1..]),
        Some("merge") => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, "merge"));
            Ok(())
        }
        // `suppress`/`unsuppress` (#3725) — permanently remove a packaged builtin component (a plain
        // `remove` re-seeds on the next hydrate). Scope gate above applies.
        Some("suppress") if args.get(1).map(String::as_str) != Some("help") => {
            cmd_suppress(&args[1..], open_component_store, "component")
        }
        Some("unsuppress") if args.get(1).map(String::as_str) != Some("help") => {
            cmd_unsuppress(&args[1..], open_component_store, "component")
        }
        Some(v @ ("suppress" | "unsuppress")) => {
            print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMPONENT_COMMANDS, v));
            Ok(())
        }
        // `list --shape <shape>` (#2475) filters to one shape's ideal components — intercepted here
        // (the shared store CLI rejects unknown flags); a plain `list` still delegates unchanged.
        Some("list") if args.iter().any(|a| a == "--shape") => cmd_list_shape(&args[1..]),
        // #4158 (designer request #44): `list --kit <id>` filters to ONE kit. Intercepted here for the
        // same reason `--shape` is — the shared store CLI rejects unknown flags — and a plain `list`
        // still delegates unchanged. Without it, comparing two kits' membership meant a full-store dump
        // (tens of KB) and grepping the auto-persisted tool-output file for `kitId`.
        Some("list") if args.iter().any(|a| a == "--kit") => cmd_list_kit(&args[1..]),
        // A plain `get <id>` (read) FOCUSES that component in the Design Studio preview (#3545) — a
        // `ui-focus`, so the preview follows Claude's working focus as it INSPECTS each node, not only
        // when it writes one. Distinct from the write `ui-touch`: a read triggers NO library re-hydrate.
        // `get --field`/`get help` fall through unchanged (the id guard excludes a flag or `help`).
        Some("get") if args.get(1).is_some_and(|a| !a.starts_with('-') && a != "help") => {
            bsc_util::emit_ui_focus("component", &args[1]);
            bsc_json_store::cli::run_hooked_validated(
                args,
                prog,
                &COMPONENT_SPEC,
                Some(&|id: &str| bsc_util::emit_ui_activity("component", id)),
                Some(&validate_component_batch),
            )
        }
        // The COMPONENT collection's list/get/remove (set is intercepted above, #3164). Fire the
        // live-focus `ui-touch` (#2525) after a component remove write lands, with the "component"
        // collection context.
        _ => bsc_json_store::cli::run_hooked_validated(
            args,
            prog,
            &COMPONENT_SPEC,
            Some(&|id: &str| bsc_util::emit_ui_activity("component", id)),
            Some(&validate_component_batch),
        ),
    }
}

// ── record history / attribution / optimistic concurrency (#3164) ────────────────────────────────
//
// Every `bsc ui` write STAMPS provenance so a background rewrite can't silently clobber a record with
// no trace: `rev` (auto-bumped integer), `updatedAt` (ISO-8601 UTC), `updatedBy` (writer tag). The
// stores stay verbatim JSON, so the stamping lives here (the crate owning the record shape), on the
// write boundary shared by `set`, the animation authors, and doctor `--fix` — see [`crate::record`].

/// The record's CURRENT stored `rev` (0 when absent or never stamped — the backward-compat contract),
/// read straight from the store so a stamp/version-check always compares against what's on disk.
#[cfg(test)]
fn current_rev(store: &bsc_json_store::Store, id: &str) -> Result<i64, String> {
    Ok(crate::record::read_rev(&current_record(store, id)?))
}

/// The record's CURRENT stored JSON (`Value::Null` when absent), so a write can carry its change history
/// forward and diff what changed (#3568). Malformed stored JSON reads as absent (fail-safe: the write
/// still lands, just starting a fresh history rather than erroring on a corrupt row).
fn current_record(store: &bsc_json_store::Store, id: &str) -> Result<serde_json::Value, String> {
    Ok(store.get(id)?.and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok()).unwrap_or(serde_json::Value::Null))
}

/// Stamp `value` for a write (bump `rev`, set `updatedAt` + `updatedBy`), then upsert it by `id`. The
/// single write boundary EVERY non-`set` writer funnels through (the animation authors, doctor `--fix`
/// repoints), so they all get a consistent rev bump + attribution; `writer` is the resolved tag (see
/// [`crate::record::resolve_writer`]).
fn stamped_set(
    store: &bsc_json_store::Store,
    id: &str,
    mut value: serde_json::Value,
    writer: &str,
) -> Result<(), String> {
    let prior = current_record(store, id)?;
    crate::record::stamp_with_history(&mut value, &prior, writer, &crate::record::now_iso(), None);
    store.set(id, &serde_json::to_string(&value).map_err(|e| format!("set: {e}"))?)
}

/// Read the `set` payload — a single record object OR an array of them — into a `Vec`.
///
/// Two channels, identical semantics (#3373): stdin, or `--file <bare-name>` resolved inside the
/// session's sealed `$BSC_SCRATCH` dir. The file form exists because a heredoc cannot be allow-listed
/// (newlines are command separators), which left a restricted studio session unable to author at all.
/// `bsc_cli_util::read_payload` owns the resolution + the traversal defence.
fn read_set_items(noun: &str, file: Option<&str>) -> Result<Vec<serde_json::Value>, String> {
    let raw = bsc_cli_util::read_payload(file)?;
    let where_ = if file.is_some() { "in --file" } else { "on stdin" };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("{noun} JSON {where_} is invalid: {e}"))?;
    Ok(match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    })
}

/// The stamped, version-aware `set` core (#3164): for each item, read the current stored `rev`, enforce
/// `--if-version` (reject a stale overwrite), stamp (`rev+1` + `updatedAt` + `updatedBy`), upsert, and
/// fire the ui-touch hook. Returns the written ids in input order. Split out of [`cmd_set`] so the
/// concurrency + stamping logic is unit-testable without a drivable stdin. `--if-version` takes a
/// SINGLE record (a lone version number is meaningless across a batch).
fn set_stamped(
    store: &bsc_json_store::Store,
    items: &[serde_json::Value],
    if_version: Option<i64>,
    writer: &str,
    noun: &str,
    note: Option<&str>,
) -> Result<Vec<String>, String> {
    if if_version.is_some() && items.len() != 1 {
        return Err(format!(
            "--if-version guards a single {noun} write, but stdin held {} records — send exactly one record when using optimistic concurrency",
            items.len()
        ));
    }
    let now = crate::record::now_iso();
    let mut ids = Vec::new();
    for item in items {
        let id = bsc_json_store::cli::id_of(item, noun)?;
        let prior = current_record(store, &id)?;
        let prior_rev = crate::record::read_rev(&prior);
        if let Some(n) = if_version {
            if prior_rev != n {
                return Err(format!(
                    "version conflict on {noun} '{id}': its current rev is {prior_rev}, not {n} — it changed since you read it. Re-read (`bsc ui log {id}`) and retry."
                ));
            }
        }
        let mut stamped = item.clone();
        crate::record::stamp_with_history(&mut stamped, &prior, writer, &now, note);
        store.set(&id, &serde_json::to_string(&stamped).map_err(|e| format!("set: {e}"))?)?;
        bsc_util::emit_ui_activity(noun, &id);
        // #43: editing a COMPONENT invalidates the last preview render — clear any stale `render-error` so
        // `bsc ui doctor` doesn't keep reporting the pre-edit throw for source that just changed. Best-effort
        // (a diagnostic side-effect must never fail the write); a no-op unless this id currently has an error.
        if noun == "component" {
            let _ = crate::preview_errors::clear(&id);
        }
        ids.push(id);
    }
    Ok(ids)
}

/// `set [--by <tag>] [--note <text>] [--if-version <n>] [--dir D] [--pretty]` (#3164/#3568) — the
/// STAMPING upsert for a collection. Parses the ui-write flags, reads the record(s) from stdin, runs the
/// domain batch `validate` (the component srcText gate / the kit-axis nudge), then stamps + upserts each
/// via [`set_stamped`], which also appends a change-history entry (`--note` is its summary; `bsc ui log
/// <id>` reads the log). Prints the written id(s). Shared by the component and kit collections (`open` +
/// `validate` + `noun` differ). Already ui-scope gated in [`run`].
fn cmd_set(
    args: &[String],
    open: fn(&Option<String>) -> Result<bsc_json_store::Store, String>,
    validate: fn(&[serde_json::Value]) -> Result<(), String>,
    noun: &'static str,
) -> Result<(), String> {
    let (mut dir, mut pretty, mut by, mut if_version, mut file, mut note) =
        (None::<String>, false, None::<String>, None::<i64>, None::<String>, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            // #3373: read the payload from a BARE-NAMED file in $BSC_SCRATCH instead of stdin, so a
            // restricted session can author multi-line records at all (a heredoc cannot be allow-listed
            // — newlines are command separators). Resolution + the traversal defence live in bsc-cli-util.
            "--file" => file = it.next().cloned(),
            "--by" => by = it.next().cloned(),
            // #3568: a human-readable summary of WHY this write happened, recorded in the change history.
            "--note" => note = it.next().cloned(),
            "--if-version" => {
                let raw = it.next().ok_or("--if-version needs an integer revision (see `bsc ui log <id>`)")?;
                if_version = Some(
                    raw.parse::<i64>()
                        .map_err(|_| format!("--if-version '{raw}' is not an integer"))?,
                );
            }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => {
                return Err(format!(
                    "unexpected argument '{other}' — `set` reads the record(s) from stdin, or from                      --file <name> in $BSC_SCRATCH"
                ))
            }
        }
    }
    let items = read_set_items(noun, file.as_deref())?;
    validate(&items)?;
    let store = open(&dir)?;
    // #3729: a component store is keyed by id ALONE — writing an id that already lives under a DIFFERENT
    // kit silently OVERWRITES it. Warn (never reject) so a promote-over-a-builtin clobber is visible.
    if noun == "component" {
        warn_cross_kit_collision(&store, &items);
    }
    let writer = crate::record::resolve_writer(by.as_deref());
    let ids = set_stamped(&store, &items, if_version, &writer, noun, note.as_deref())?;
    let json = if pretty { serde_json::to_string_pretty(&ids) } else { serde_json::to_string(&ids) };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// The cross-kit id-overwrite warnings for a `set` batch (#3729) — PURE so the decision is under test;
/// the CLI prints each to stderr via [`warn_cross_kit_collision`]. The component store is keyed by id
/// ALONE (not by `(kit, id)`), so writing `fleetpage` under kit `harvested` SILENTLY OVERWRITES a
/// `fleetpage` already stored under `base-studio-code` — that bit a designer promoting a harvested page
/// over a builtin of the same name (they believed the two coexisted). One message per colliding id.
fn cross_kit_collision_warnings(store: &bsc_json_store::Store, items: &[serde_json::Value]) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        let (Some(id), Some(new_kit)) = (
            item.get("id").and_then(serde_json::Value::as_str),
            item.get("kitId").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        let prior = current_record(store, id).unwrap_or(serde_json::Value::Null);
        let prior_kit = prior.get("kitId").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !prior_kit.is_empty() && prior_kit != new_kit {
            out.push(format!(
                "warning: component '{id}' already exists under kit '{prior_kit}' — this write (kit '{new_kit}') \
                 OVERWRITES it, because the store is keyed by id, NOT by (kit, id). Rename one of them if you \
                 meant to keep both, or ignore this if the re-home is intended."
            ));
        }
    }
    out
}

/// Print each [`cross_kit_collision_warnings`] message to stderr. Non-blocking (never rejects) — a
/// deliberate re-home is legitimate and the write still lands.
fn warn_cross_kit_collision(store: &bsc_json_store::Store, items: &[serde_json::Value]) {
    for w in cross_kit_collision_warnings(store, items) {
        eprintln!("{w}");
    }
}

/// A valid component NAME — a PascalCase identifier: an uppercase ASCII first char, then ASCII
/// alphanumerics. React cannot treat a lowercase name as a component, so the capital is a real rule, not a
/// style one; alphanumeric-only keeps the derived `--<name>-<token>` conventions and JSX tag clean.
fn is_component_name_ident(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase()) && chars.all(|c| c.is_ascii_alphanumeric())
}

/// Replace WHOLE-IDENTIFIER occurrences of `old` with `new` in `text` — `old` must be bounded on both
/// sides by a non-identifier char (or the string edge), so renaming `Button` never rewrites `IconButton`
/// or `ButtonGroup`. Identifier chars are ASCII alphanumeric, `_`, and `$` (the JS identifier set).
/// Component names are ASCII, so matching on char boundaries is safe. Used to rewrite the renamed
/// component's own `srcText`/`source` identifier.
fn rename_ident(text: &str, old: &str, new: &str) -> String {
    if old.is_empty() {
        return text.to_string();
    }
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text[i..].starts_with(old) {
            let before_ok = i == 0 || !text[..i].chars().next_back().is_some_and(is_ident);
            let after = i + old.len();
            let after_ok = after >= text.len() || !text[after..].chars().next().is_some_and(is_ident);
            if before_ok && after_ok {
                out.push_str(new);
                i = after;
                continue;
            }
        }
        let ch = text[i..].chars().next().expect("i is a char boundary");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `rename <id> <NewName> [--by <tag>] [--note <text>] [--dir D] [--pretty]` (#3576) — rename a component
/// in place. `id` is the STABLE store key (frozen at creation, never re-derived), so only the NAME moves:
/// the record's `name` + the identifier in its `srcText`/`source`, and — because the composition graph is
/// NAME-keyed (`model.ts`) — every sibling's `composes[]` + `rules[].use` that named it, swept across the
/// SAME kit only (kits never cross). Every touched record gets a change-history entry (#3568). Everything
/// keyed by id (store key, history, tokens, cross-graph URN) is untouched. A ui-scope MUTATION.
fn cmd_rename(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut by, mut note) = (None::<String>, false, None::<String>, None::<String>);
    let mut positionals: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            "--by" => by = it.next().cloned(),
            "--note" => note = it.next().cloned(),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional => positionals.push(positional.to_string()),
        }
    }
    let id = positionals
        .first()
        .ok_or("usage: bsc ui rename <id> <NewName> [--by <tag>] [--note <text>]")?;
    let new_name = positionals
        .get(1)
        .ok_or("usage: bsc ui rename <id> <NewName> — the new PascalCase name is required")?;
    if !is_component_name_ident(new_name) {
        return Err(format!(
            "'{new_name}' is not a valid component name — a component is a PascalCase identifier ([A-Z][A-Za-z0-9]*)"
        ));
    }

    let store = open_component_store(&dir)?;
    let target_raw = store.get(id)?.ok_or_else(|| {
        format!("no component '{id}' in the store — nothing to rename (ids are stable; see `bsc ui list`)")
    })?;
    let target: serde_json::Value = serde_json::from_str(&target_raw)
        .map_err(|e| format!("stored component '{id}' is not valid JSON: {e}"))?;
    let old_name = target.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if old_name.is_empty() {
        return Err(format!("component '{id}' has no `name` to rename"));
    }
    if old_name == *new_name {
        return Err(format!("component '{id}' is already named '{new_name}' — nothing to do"));
    }
    let kit_id = target.get("kitId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();

    let records: Vec<serde_json::Value> =
        store.list().iter().filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok()).collect();
    // Collision: `composes` resolves by NAME within a kit, so two same-named components in one kit make it
    // ambiguous. Refuse before writing anything.
    let collides = records.iter().any(|r| {
        r.get("kitId").and_then(serde_json::Value::as_str) == Some(kit_id.as_str())
            && r.get("name").and_then(serde_json::Value::as_str) == Some(new_name.as_str())
            && r.get("id").and_then(serde_json::Value::as_str) != Some(id.as_str())
    });
    if collides {
        return Err(format!(
            "kit '{kit_id}' already has a component named '{new_name}' — a rename would make `composes` ambiguous (it resolves by name within a kit). Pick another name."
        ));
    }

    let now = crate::record::now_iso();
    let writer = crate::record::resolve_writer(by.as_deref());
    let default_note = format!("renamed {old_name} → {new_name}");
    let note_str = note.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&default_note);

    let mut updated: Vec<String> = Vec::new();
    for mut rec in records {
        // The sweep is bounded to the renamed component's OWN kit — kits never cross, so a same-named
        // component elsewhere is a different component and must NOT be touched.
        if rec.get("kitId").and_then(serde_json::Value::as_str) != Some(kit_id.as_str()) {
            continue;
        }
        let rid = match rec.get("id").and_then(serde_json::Value::as_str) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        let mut changed = false;

        if rid == *id {
            rec["name"] = serde_json::Value::from(new_name.as_str());
            changed = true;
            // Rewrite the identifier in the component's own source (usage snippet + any vendored module).
            for field in ["srcText", "source"] {
                if let Some(s) = rec.get(field).and_then(serde_json::Value::as_str) {
                    let rewritten = rename_ident(s, &old_name, new_name);
                    if rewritten != s {
                        rec[field] = serde_json::Value::from(rewritten);
                    }
                }
            }
        }
        // Every record in the kit: rewrite composes[] + rules[].use references to the old name.
        if let Some(arr) = rec.get_mut("composes").and_then(serde_json::Value::as_array_mut) {
            for e in arr.iter_mut() {
                if e.as_str() == Some(old_name.as_str()) {
                    *e = serde_json::Value::from(new_name.as_str());
                    changed = true;
                }
            }
        }
        if let Some(rules) = rec.get_mut("rules").and_then(serde_json::Value::as_array_mut) {
            for rule in rules.iter_mut() {
                if rule.get("use").and_then(serde_json::Value::as_str) == Some(old_name.as_str()) {
                    rule["use"] = serde_json::Value::from(new_name.as_str());
                    changed = true;
                }
            }
        }

        if changed {
            let prior = current_record(&store, &rid)?;
            crate::record::stamp_with_history(&mut rec, &prior, &writer, &now, Some(note_str));
            store.set(&rid, &serde_json::to_string(&rec).map_err(|e| format!("rename write: {e}"))?)?;
            bsc_util::emit_ui_activity("component", &rid);
            updated.push(rid);
        }
    }

    let references_updated = updated.iter().filter(|u| *u != id).count();
    let out = serde_json::json!({
        "id": id,
        "from": old_name,
        "to": new_name,
        "kit": kit_id,
        "updated": updated,
        "referencesUpdated": references_updated,
    });
    let text = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
    println!("{}", text.map_err(|e| e.to_string())?);
    Ok(())
}

/// `merge <from-id> <into-id> [--by <tag>] [--note <text>] [--dir D] [--pretty]` (#3592) — fold the
/// component `from` INTO `into` (the survivor) and remove `from`. The ACT step of the optimize loop
/// (`dupes`/`similar` only propose). `into` stays authoritative; every same-kit `composes[]`/`rules[].use`
/// that named `from` is repointed to `into` (deduped; a self-reference the fold would create is dropped),
/// then `from` is deleted. Every repointed record gets a change-history entry (#3568). Scoped to the kit
/// (`composes` is name-keyed; a cross-kit merge is refused). A ui-scope MUTATION, gated in [`run`].
fn cmd_merge(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut by, mut note) = (None::<String>, false, None::<String>, None::<String>);
    let mut positionals: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            "--by" => by = it.next().cloned(),
            "--note" => note = it.next().cloned(),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional => positionals.push(positional.to_string()),
        }
    }
    let from_id = positionals.first().ok_or("usage: bsc ui merge <from-id> <into-id> [--by <tag>] [--note <text>]")?;
    let into_id = positionals.get(1).ok_or("usage: bsc ui merge <from-id> <into-id> — the survivor id is required")?;
    if from_id == into_id {
        return Err(format!("cannot merge '{from_id}' into itself"));
    }

    let store = open_component_store(&dir)?;
    let load = |id: &str| -> Result<serde_json::Value, String> {
        let raw = store
            .get(id)?
            .ok_or_else(|| format!("no component '{id}' in the store (see `bsc ui list --raw`)"))?;
        serde_json::from_str(&raw).map_err(|e| format!("stored component '{id}' is not valid JSON: {e}"))
    };
    let from = load(from_id)?;
    let into = load(into_id)?;
    let from_name = from.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    let into_name = into.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if from_name.is_empty() || into_name.is_empty() {
        return Err("both components must have a `name` to merge".to_string());
    }
    let from_kit = from.get("kitId").and_then(serde_json::Value::as_str).unwrap_or("");
    let into_kit = into.get("kitId").and_then(serde_json::Value::as_str).unwrap_or("");
    if from_kit != into_kit {
        return Err(format!(
            "'{from_id}' is in kit '{from_kit}' but '{into_id}' is in '{into_kit}' — `composes` is name-keyed WITHIN a kit, so a cross-kit merge is unsafe. Move one into the other's kit first, or merge within a kit."
        ));
    }
    let kit_id = from_kit.to_string();

    let now = crate::record::now_iso();
    let writer = crate::record::resolve_writer(by.as_deref());
    let default_note = format!("merged {from_name} → {into_name}");
    let note_str = note.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or(&default_note);

    let records: Vec<serde_json::Value> =
        store.list().iter().filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok()).collect();
    let mut repointed: Vec<String> = Vec::new();
    for mut rec in records {
        // Only same-kit records reference `from` by name; and the `from` record itself is being removed.
        if rec.get("kitId").and_then(serde_json::Value::as_str) != Some(kit_id.as_str()) {
            continue;
        }
        let rid = match rec.get("id").and_then(serde_json::Value::as_str) {
            Some(s) if !s.is_empty() && s != from_id => s.to_string(),
            _ => continue,
        };
        let own_name = rec.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let mut changed = false;

        if let Some(arr) = rec.get_mut("composes").and_then(serde_json::Value::as_array_mut) {
            let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            let mut next: Vec<serde_json::Value> = Vec::with_capacity(arr.len());
            let mut any = false;
            for e in arr.iter() {
                let Some(orig) = e.as_str() else { continue };
                let mapped: &str = if orig == from_name.as_str() { into_name.as_str() } else { orig };
                if orig == from_name.as_str() {
                    any = true; // a from → into repoint
                }
                // Drop a self-reference the fold would create, and dedup (a component that composed BOTH
                // `from` AND `into` must not end up composing `into` twice).
                if mapped == own_name.as_str() || !seen.insert(mapped.to_string()) {
                    any = true;
                    continue;
                }
                next.push(serde_json::Value::from(mapped));
            }
            if any {
                *arr = next;
                changed = true;
            }
        }
        if let Some(rules) = rec.get_mut("rules").and_then(serde_json::Value::as_array_mut) {
            for rule in rules.iter_mut() {
                if rule.get("use").and_then(serde_json::Value::as_str) == Some(from_name.as_str()) {
                    rule["use"] = serde_json::Value::from(into_name.as_str());
                    changed = true;
                }
            }
        }

        if changed {
            let prior = current_record(&store, &rid)?;
            crate::record::stamp_with_history(&mut rec, &prior, &writer, &now, Some(note_str));
            store.set(&rid, &serde_json::to_string(&rec).map_err(|e| format!("merge write: {e}"))?)?;
            bsc_util::emit_ui_activity("component", &rid);
            repointed.push(rid);
        }
    }

    // Remove the merged-away component LAST, once every reference is repointed.
    store.remove(from_id)?;
    bsc_util::emit_ui_activity("component", from_id);

    let out = serde_json::json!({
        "from": from_id,
        "into": into_id,
        "kit": kit_id,
        "repointed": repointed,
        "removed": from_id,
    });
    let text = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
    println!("{}", text.map_err(|e| e.to_string())?);
    Ok(())
}

/// `regroup [--kit <id>] [--dir D] [--dry-run] [--pretty]` (#3579) — re-derive every stored component's
/// `group` as a nested `/`-delimited FOLDER PATH from its `src` ([`crate::group_from_src`]), so a kit
/// organizes like a completed project's folders (`shared/ui/controls`, `features/github`). Rewrites ONLY
/// the records whose derived group differs (each write stamped + logged via [`set_stamped`]); a record
/// with no usable `src` is left untouched. `--kit` scopes the pass to one kit; `--dry-run` reports the
/// moves without writing. Prints `{ scanned, changed: [{ id, from, to }], applied }`. A ui-scope
/// mutation, gated in [`run`].
/// A record's FOLDER, accepting the legacy key (#4107 slice B).
///
/// The store holds records written under `group`, and the component seed dir is skipped by
/// `ensure_seeded`, so there is no config-mirror pass to migrate them. Every READ therefore accepts
/// both names while every WRITE emits only `folder`: a record migrates the first time it is rewritten,
/// and `bsc ui refolder` does the whole store in one pass. Nothing needs migrating before this ships.
pub(crate) fn record_folder(rec: &serde_json::Value) -> Option<&str> {
    rec.get("folder")
        .or_else(|| rec.get("group"))
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
}

fn cmd_refolder(args: &[String]) -> Result<(), String> {
    let (mut dir, mut kit, mut dry, mut pretty) = (None::<String>, None::<String>, false, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--kit" => kit = it.next().cloned(),
            "--dry-run" => dry = true,
            "--pretty" => pretty = true,
            other => {
                return Err(format!(
                    "unknown flag '{other}' — usage: bsc ui regroup [--kit <id>] [--dry-run] [--pretty]"
                ))
            }
        }
    }
    let store = open_component_store(&dir)?;
    let mut scanned = 0usize;
    let mut changed = Vec::new();
    let mut updated = Vec::new();
    // `Store::list()` yields each record's VERBATIM JSON (NOT its id) — parse each directly; the id is
    // the record's own `id` field (which `set_stamped` also keys the write off).
    for raw in store.list() {
        let mut rec: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("a stored component is not valid JSON: {e}"))?;
        if let Some(k) = &kit {
            if rec.get("kitId").and_then(serde_json::Value::as_str) != Some(k.as_str()) {
                continue;
            }
        }
        scanned += 1;
        let src = rec.get("src").and_then(serde_json::Value::as_str).unwrap_or_default();
        let Some(new_folder) = crate::folder_from_src(src) else { continue };
        let old = record_folder(&rec).unwrap_or_default().to_string();
        if old == new_folder && rec.get("group").is_none() {
            continue;   // already correct AND already migrated off the legacy key
        }
        let id = rec.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
        changed.push(serde_json::json!({ "id": id, "from": old, "to": new_folder }));
        rec["folder"] = serde_json::Value::String(new_folder);
        // Drop the legacy key so a rewritten record carries ONE name for its folder — otherwise a stale
        // `group` lingers beside the new `folder` and the two can drift.
        if let Some(o) = rec.as_object_mut() { o.remove("group"); }
        updated.push(rec);
    }
    let applied = if !dry && !updated.is_empty() {
        let writer = crate::record::resolve_writer(None);
        set_stamped(&store, &updated, None, &writer, "component", Some("refolder: folder path from src"))?;
        true
    } else {
        false
    };
    let report = serde_json::json!({ "scanned": scanned, "changed": changed, "applied": applied });
    let out = if pretty { serde_json::to_string_pretty(&report) } else { serde_json::to_string(&report) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// `bsc ui export <dir> [--dir <store>] [--pretty]` (#3606) — dump the component store to a folder tree,
/// `<dir>/<group>/<id>.json`, so components-as-data round-trips: the seed half `bsc ui import` reads it back.
/// Files are written pretty (readable git diffs); `--pretty` also indents the stdout report.
fn cmd_export(args: &[String]) -> Result<(), String> {
    let (mut out, mut dir, mut pretty) = (None::<String>, None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if !other.starts_with("--") && out.is_none() => out = Some(other.to_string()),
            other => return Err(format!("unknown flag '{other}' — usage: bsc ui export <dir> [--dir <store>] [--pretty]")),
        }
    }
    let out = out.ok_or("usage: bsc ui export <dir> [--dir <store>] [--pretty]")?;
    let store = open_component_store(&dir)?;
    let out_root = std::path::Path::new(&out);
    let mut ids = Vec::new();
    for raw in store.list() {
        let rec: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("a stored component is not valid JSON: {e}"))?;
        let id = rec.get("id").and_then(serde_json::Value::as_str).ok_or("a stored component has no `id`")?;
        // `folder` is a `/`-delimited FOLDER PATH (#3579) → nest the file, so the tree mirrors the
        // project. Read through `record_folder` so a record still carrying the legacy `group` key
        // exports into the same tree rather than silently flattening to the root.
        let folder = record_folder(&rec).unwrap_or("");
        let mut path = out_root.to_path_buf();
        for seg in folder.split('/').filter(|s| !s.is_empty()) {
            path.push(seg);
        }
        std::fs::create_dir_all(&path).map_err(|e| format!("cannot create {}: {e}", path.display()))?;
        path.push(format!("{id}.json"));
        let text = serde_json::to_string_pretty(&rec).map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        ids.push(id.to_string());
    }
    let report = serde_json::json!({ "exported": ids.len(), "dir": out, "ids": ids });
    let s = if pretty { serde_json::to_string_pretty(&report) } else { serde_json::to_string(&report) };
    println!("{}", s.map_err(|e| e.to_string())?);
    Ok(())
}

/// `bsc ui import <dir> [--dir <store>] [--pretty]` (#3606) — load a folder tree of component records into
/// the store (the load half of components-as-data). Each `*.json` is UPSERT by its `id`; a KIT BUNDLE
/// (`{"components":[…]}`, e.g. react-ui.json) is exploded so every component in it imports.
fn cmd_import(args: &[String]) -> Result<(), String> {
    let (mut inp, mut dir, mut pretty) = (None::<String>, None::<String>, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            other if !other.starts_with("--") && inp.is_none() => inp = Some(other.to_string()),
            other => return Err(format!("unknown flag '{other}' — usage: bsc ui import <dir> [--dir <store>] [--pretty]")),
        }
    }
    let inp = inp.ok_or("usage: bsc ui import <dir> [--dir <store>] [--pretty]")?;
    let store = open_component_store(&dir)?;
    let mut files = Vec::new();
    collect_json_files(std::path::Path::new(&inp), &mut files).map_err(|e| format!("cannot read {inp}: {e}"))?;
    files.sort(); // deterministic import order (stable across platforms)
    let mut ids = Vec::new();
    for f in &files {
        let raw = std::fs::read_to_string(f).map_err(|e| format!("cannot read {}: {e}", f.display()))?;
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("{} is not valid JSON: {e}", f.display()))?;
        // A kit bundle → import each of its components; anything else is a single record.
        let records: Vec<&serde_json::Value> = match v.get("components").and_then(|c| c.as_array()) {
            Some(arr) => arr.iter().collect(),
            None => vec![&v],
        };
        for rec in records {
            let id = rec
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("a record in {} has no `id`", f.display()))?;
            store.set(id, &serde_json::to_string(rec).map_err(|e| e.to_string())?)?;
            bsc_util::emit_ui_activity("component", id); // Design Studio live-focus (#2525) re-hydrates
            ids.push(id.to_string());
        }
    }
    let report = serde_json::json!({ "imported": ids.len(), "dir": inp, "ids": ids });
    let s = if pretty { serde_json::to_string_pretty(&report) } else { serde_json::to_string(&report) };
    println!("{}", s.map_err(|e| e.to_string())?);
    Ok(())
}

/// Recursively collect every `*.json` under `root` (a missing dir ⇒ empty, matching the store's leniency).
fn collect_json_files(root: &std::path::Path, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_json_files(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "json") {
            out.push(path);
        }
    }
    Ok(())
}

/// `log <id> [--kit] [--dir D] [--pretty]` (#3164) — print a record's history stamp
/// (`{ id, rev, updatedAt, updatedBy }`). A read verb (never scope-gated). `--kit` logs a kit record.
fn cmd_log(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut kit, mut id) = (None::<String>, false, false, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            "--kit" => kit = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional => id = Some(positional.to_string()),
        }
    }
    let id = id.ok_or("usage: bsc ui log <id> [--kit]")?;
    let store = if kit { open_kit_store(&dir)? } else { open_component_store(&dir)? };
    let raw = store
        .get(&id)?
        .ok_or_else(|| format!("no record '{id}' in the store — nothing to log"))?;
    let record: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("stored record '{id}' is not valid JSON: {e}"))?;
    let out_val = crate::record::log_value(&id, &record);
    let out = if pretty { serde_json::to_string_pretty(&out_val) } else { serde_json::to_string(&out_val) };
    println!("{}", out.map_err(|e| e.to_string())?);
    Ok(())
}

/// Write-time gate for a `bsc ui set` batch (#2928): for each record whose `srcText` claims to be a
/// module (`looks_buildable_module` — the preview's own buildability test, modulo the #3470 elision
/// accuracy fix), run the module-syntax check and reject the whole batch on the first defect — so a silently-corrupted source (an unterminated string
/// from an escape-collapse) can't be stored. A record with no `srcText` is fine.
///
/// A `srcText` that is NOT a module is still stored (a spec-only record is legitimate), but that is now
/// a STATED outcome rather than a silent skip (#3470): it warns on stderr, naming every reason. The old
/// shape inverted the gate at the edges — the source least like a module (one keeping its unresolved
/// `@/…` imports) made the predicate false, which skipped the syntax check ENTIRELY, so it stored with
/// zero complaint and only surfaced much later as a `no-implementation` finding in `bsc ui doctor`, far
/// from the write that caused it.
///
/// ALSO (non-blocking, #3065): warns on stderr for a bad INLINE animation def on the record's
/// `animations`, but never rejects over one. The srcText Err semantics are unchanged; both warnings are
/// pure side-effects. Driven directly by tests.
fn validate_component_batch(items: &[serde_json::Value]) -> Result<(), String> {
    for item in items {
        // #3065: non-blocking — runs for EVERY item, BEFORE the srcText early-continue below, so an
        // inline-animation warning surfaces even on a component whose `srcText` isn't a buildable module.
        warn_component_animations(item);
        // #3709: same — a JSX-text unicode-escape leak surfaces on any item with source, even a spec.
        warn_jsx_text_escapes(item);

        let src_text = item.get("srcText").and_then(serde_json::Value::as_str).unwrap_or_default();
        if src_text.trim().is_empty() {
            continue; // no source to judge — a record can legitimately carry none.
        }
        // #43: a graph-source component (carries `provides`) is a real app primitive whose `@/` imports the
        // runtime loader — and the now provides-aware preview build/doctor — resolve. `looks_buildable_module`
        // treats ANY `@/` import as unbuildable, so it emits a FALSE "unresolved first-party @/" warning for
        // it. Skip the buildability advisory for these (buildability is judged by `doctor`); the syntax check
        // below still runs, so real corruption is still caught.
        let provides = item.get("provides").and_then(serde_json::Value::as_str).unwrap_or_default();
        // #3470: not-a-module is REPORTED, never an unchecked skip. Still permissive — it stores.
        if provides.trim().is_empty() && !crate::graph_health::looks_buildable_module(src_text) {
            eprintln!("{}", unbuildable_module_warning(item, src_text));
            continue;
        }
        if let Err(msg) = crate::syntax::check_module_syntax(src_text) {
            return Err(format!(
                "{}: {msg} — its srcText looks like a module but won't build. Fix it, or author it from a raw file to avoid shell-escaping corruption.",
                item_label(item)
            ));
        }
    }
    Ok(())
}

/// The stderr advisory (#3470) for a non-empty `srcText` that `looks_buildable_module` rejected. Names
/// every reason `module_defects` found and says plainly what just got stored, so "this is a spec, not
/// code" is something the writer sees AT WRITE TIME instead of discovering days later as a `doctor`
/// finding. Returns the message rather than printing it so the wording is under test, like the batch
/// result. (Only called on the not-a-module branch, where the defect list is non-empty by construction.)
fn unbuildable_module_warning(item: &serde_json::Value, src_text: &str) -> String {
    format!(
        "warning: component '{}' has a srcText that is NOT a buildable module: {} — it is stored as a SPEC, not as compilable code, so the Design Studio preview will show no implementation and `bsc ui doctor` will report it. Author a self-contained module (inline or vendor what it imports) if you meant to ship code.",
        item_label(item),
        crate::graph_health::module_defects(src_text).join("; ")
    )
}

/// The human handle for a record in a write-time message — its `name`, else its `id`, else the generic
/// noun. One helper so the syntax REJECTION and the not-a-module WARNING point at the same string.
fn item_label(item: &serde_json::Value) -> &str {
    item.get("name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| item.get("id").and_then(serde_json::Value::as_str))
        .unwrap_or("component")
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

/// Non-blocking write-time advisory (#3709) for a JS unicode/hex escape (`\uXXXX`, `\u{…}`, `\xHH`)
/// sitting in JSX-TEXT / code position — OUTSIDE any string literal, template, or comment. JSX children
/// text is not a JS string, so a bare escape typed directly between tags is never interpreted: the browser
/// renders the literal `backslash-u-…` characters, not the glyph. It passes the syntax check (valid JS) and
/// stores clean, so ONLY a screenshot catches it — a semantic-but-not-syntactic defect the build can't see.
/// WARN (naming the leaked escapes + the fix — a real UTF-8 char, or a JS string like `{"·"}`), but
/// NEVER reject: the record is valid JS. Purely advisory, like [`warn_component_animations`].
fn warn_jsx_text_escapes(item: &serde_json::Value) {
    let src_text = item.get("srcText").and_then(serde_json::Value::as_str).unwrap_or_default();
    let leaks = crate::graph_health::jsx_text_escape_leaks(src_text);
    if leaks.is_empty() {
        return;
    }
    // Unique escapes, first-seen order, capped so a component riddled with them stays one readable line.
    let mut seen = std::collections::BTreeSet::new();
    let uniq: Vec<&str> =
        leaks.iter().filter(|e| seen.insert(e.as_str())).map(String::as_str).collect();
    let shown = uniq.iter().take(5).copied().collect::<Vec<_>>().join(", ");
    let more = if uniq.len() > 5 { format!(", +{} more", uniq.len() - 5) } else { String::new() };
    eprintln!(
        "warning: component '{}' has {} unicode escape(s) in JSX-text position ({shown}{more}) — a JS escape typed directly between JSX tags renders as the literal backslash-text, NOT the glyph. Use a real UTF-8 character, or wrap it in a JS string like {{\"\\u00b7\"}}.",
        item_label(item),
        leaks.len(),
    );
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

/// Validate a shape token against the seven-shape vocabulary (#2475/#3517); the error teaches the whole set.
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
                .map(|j| bsc_json_store::cli::lean_meta_aliased(j, COMPONENT_SPEC.meta_fields, COMPONENT_SPEC.field_aliases))
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

/// `list --shape <shape> [--full] [--dir D] [--pretty] [--raw]` — the filtered twin of the store `list`
/// (#2475): only the components whose `shapes` field stamps <shape>, in the SAME lean projection
/// (or --full objects, or --raw ids). Validates the shape BEFORE any store is touched. `--raw` (#3166)
/// keeps the shared byte-clean id-per-line output consistent with the plain `list --raw`.
fn cmd_list_shape(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut full, mut raw, mut shape) =
        (None::<String>, false, false, false, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--shape" => shape = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            "--full" => full = true,
            "--raw" => raw = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => {}
        }
    }
    let shape = shape.ok_or("--shape needs a value (see `bsc ui shapes`)")?;
    require_shape(&shape)?;
    let store = open_component_store(&dir)?;
    let stored = store.list();
    let selected: Vec<&String> = stored.iter().filter(|j| json_has_shape(j, &shape)).collect();
    if raw {
        // Byte-clean id list of the filtered set — same contract as the shared `list --raw` (#3166).
        let ids: Vec<String> = selected.iter().filter_map(|j| bsc_json_store::cli::id_field(j)).collect();
        bsc_cli_util::print_raw_lines(&ids);
        return Ok(());
    }
    let out: Vec<serde_json::Value> = if full {
        selected.iter().filter_map(|j| serde_json::from_str(j).ok()).collect()
    } else {
        selected.iter().map(|j| bsc_json_store::cli::lean_meta_aliased(j, COMPONENT_SPEC.meta_fields, COMPONENT_SPEC.field_aliases)).collect()
    };
    let json = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// `list --kit <id> [--full] [--raw] [--pretty] [--dir D]` (#4158) — the component list scoped to ONE kit.
///
/// Mirrors `list --shape`'s flag set and output contract exactly (`--raw` ids, `--full` whole records,
/// else the aliased lean projection), so the only difference from a plain `list` is WHICH records it
/// selects. Filtering here rather than in the shared store CLI keeps `kitId` — a components-only field —
/// out of the generic dispatch every other store shares.
fn cmd_list_kit(args: &[String]) -> Result<(), String> {
    let (mut kit, mut dir) = (None::<String>, None::<String>);
    let (mut pretty, mut full, mut raw) = (false, false, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--kit" => kit = it.next().cloned(),
            "--dir" => dir = it.next().cloned(),
            "--pretty" => pretty = true,
            "--full" => full = true,
            "--raw" => raw = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => {}
        }
    }
    let kit = kit.ok_or("--kit needs a value (see `bsc ui kit list`)")?;
    let store = open_component_store(&dir)?;
    let stored = store.list();
    // An UNKNOWN kit yields an empty list rather than an error: "which components are in kit X" is a
    // legitimate question to ask about a kit that turns out to have none.
    let selected: Vec<&String> = stored
        .iter()
        .filter(|j| {
            serde_json::from_str::<serde_json::Value>(j)
                .ok()
                .and_then(|v| v.get("kitId").and_then(|k| k.as_str().map(str::to_owned)))
                .as_deref()
                == Some(kit.as_str())
        })
        .collect();
    if raw {
        let ids: Vec<String> = selected.iter().filter_map(|j| bsc_json_store::cli::id_field(j)).collect();
        bsc_cli_util::print_raw_lines(&ids);
        return Ok(());
    }
    let out: Vec<serde_json::Value> = if full {
        selected.iter().filter_map(|j| serde_json::from_str(j).ok()).collect()
    } else {
        selected.iter().map(|j| bsc_json_store::cli::lean_meta_aliased(j, COMPONENT_SPEC.meta_fields, COMPONENT_SPEC.field_aliases)).collect()
    };
    let json = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
    bsc_util::emit_line(&json.map_err(|e| e.to_string())?);
    Ok(())
}

/// `doctor [--kit K] [--sound-kit id@version] [--json] [--pretty]` (#2678) — the graph-health report.
/// Reads the component store, runs the pure analyzer ([`crate::graph_health::analyze_with`]), and prints
/// the ranked findings as JSON (`--json`, LLM-consumable) or a human summary. `--kit` scopes the OUTPUT to
/// one kit (the analyzer always groups by kit, so edges never cross kits regardless).
///
/// `--sound-kit` (#3412) names the project's PINNED sound kit, so `@bsc/sounds/<id>` references are judged
/// against the kit the project actually adopted — the Rust twin of the Design Studio passing its resolved
/// `SoundKitSelection`. Omitted ⇒ the packaged default kit (an unpinned project, unchanged). A ref the
/// release store does not hold is a HARD ERROR, never a quiet fall back to the default: reporting a pinned
/// project against the starter kit would call broken references clean.
/// Read a PINNED sound kit's artifact out of the global versioned release store (#3412, `bsc sound
/// release`) — the same artifact the Design Studio resolves through the `bsc` bridge, so both sides judge
/// `@bsc/sounds/…` against identical bytes.
///
/// FAILS LOUDLY on a ref the store does not hold (or a malformed `id@version`) rather than degrading to
/// the packaged default: the caller asked for a specific kit, and answering with a different one would
/// report a component's broken sound references as clean. Mirrors the frontend's `unresolved` arm.
fn read_pinned_sound_kit(kit_ref: &str) -> Result<String, String> {
    let (id, version) = bsc_sound::release::split_ref(kit_ref)?;
    let store = bsc_sound::release::ReleaseStore::open_default()?;
    store
        .artifact(id, version)?
        .ok_or_else(|| format!("sound kit '{kit_ref}' is not in the sound-kit store (`bsc sound release list`)"))
}

/// `bsc ui backing <path>` / `bsc ui backing gate <path>...` (#4193).
///
/// The read answers "does this file have a record?"; the gate turns that into a refusal, so a change that
/// edited the artifact instead of the source cannot land quietly. Rejecting rather than warning is the
/// point: a warning at landing time becomes noise and is ignored, and the drift it was meant to stop
/// accumulates anyway.
fn cmd_backing(args: &[String]) -> Result<(), String> {
    let (mut dir, mut json, mut pretty) = (None::<String>, false, false);
    let mut positional: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--json" => json = true,
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => positional.push(other.to_string()),
        }
    }
    let store = open_component_store(&dir)?;
    let records: Vec<serde_json::Value> =
        store.list().iter().filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok()).collect();

    if positional.first().map(String::as_str) == Some("gate") {
        let paths = &positional[1..];
        if paths.is_empty() {
            return Err("usage: bsc ui backing gate <path>... — pass the files your change touches (e.g. `git diff --name-only`)".into());
        }
        let mut blocked = Vec::new();
        for p in paths {
            for b in crate::backing::backing_for(&records, p) {
                blocked.push(crate::backing::rejection(p, &b));
            }
        }
        if blocked.is_empty() {
            // Say so explicitly: a silent pass is indistinguishable from a gate that did not run.
            println!("ok: none of the {} path(s) is component-backed", paths.len());
            return Ok(());
        }
        return Err(blocked.join("

"));
    }

    let path = positional
        .first()
        .ok_or("usage: bsc ui backing <path> | bsc ui backing gate <path>...")?;
    let found = crate::backing::backing_for(&records, path);
    let payload = serde_json::json!({
        "path": crate::backing::normalize(path),
        "backed": !found.is_empty(),
        "records": found.iter()
            .map(|b| serde_json::json!({ "id": b.id, "kitId": b.kit_id, "src": b.src }))
            .collect::<Vec<_>>(),
    });
    bsc_cli_util::emit(pretty, json, &payload, || {
        if found.is_empty() {
            format!("{} — not component-backed", crate::backing::normalize(path))
        } else {
            found.iter()
                .map(|b| format!("{} — component `{}` (kit `{}`)", crate::backing::normalize(path), b.id, b.kit_id))
                .collect::<Vec<_>>()
                .join("
")
        }
    });
    Ok(())
}

fn cmd_doctor(args: &[String]) -> Result<(), String> {
    let (mut dir, mut kit, mut json, mut pretty) = (None::<String>, None::<String>, false, false);
    let (mut fix, mut yes, mut motion) = (false, false, false);
    let mut sound_kit = None::<String>;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--kit" => kit = it.next().cloned(),
            // #3412: resolve `@bsc/sounds/…` against the project's PINNED kit instead of the packaged default.
            "--sound-kit" => sound_kit = it.next().cloned(),
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--fix" => fix = true,
            "--yes" => yes = true,
            // #3163: ADD the four mechanical MOTION checks to the report (an animation selector whose class
            // hook the source never renders · a stroke-dash keyframe with no pathLength · a CSS transform
            // keyframe fighting an SVG transform= attribute · a cross-component keyframe-name collision).
            "--motion" => motion = true,
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

    // Resolve the pin BEFORE analyzing so a broken pin fails the whole report rather than silently
    // producing one measured against the wrong kit (#3412).
    let sound_kit_json = match &sound_kit {
        Some(kit_ref) => Some(read_pinned_sound_kit(kit_ref)?),
        None => None,
    };
    let opts = crate::graph_health::HealthOptions { sound_kit_json: sound_kit_json.as_deref() };
    let mut findings = crate::graph_health::analyze_with(&comps, &opts);
    if motion {
        // #3163: append the motion findings (re-ranked with the render errors below).
        findings.extend(crate::graph_health::analyze_motion(&comps));
    }
    // #3540: append the RENDER errors — the runtime throws doctor's static analysis can't see, read from
    // the durable preview-error log the app's scan + previews record. Scoped to `comps` (already
    // kit-filtered), so `--kit` narrows these too. Always on: a preview that throws is the most
    // actionable finding, so it should never need a flag to surface.
    let render_errors = crate::preview_errors::latest_error_by_id();
    findings.extend(crate::graph_health::render_error_findings(&comps, &render_errors));
    // #3544: append the library-wide NEAR-duplicate findings — the fuzzy layer (name + contract distance)
    // the exact per-kit `duplicate` detector misses (`Donut`≈`DonutChart`, cross-kit `Card` repeats).
    // PROPOSE-ONLY: emitted here, never fed to `--fix` (only byte-identical merges auto-apply). Cross-kit
    // by nature, so it fires on the full report; a `--kit` scope filters `comps`, leaving within-kit dups.
    findings.extend(crate::similarity::near_duplicate_findings(&comps, crate::similarity::DEFAULT_THRESHOLD));
    // Re-rank the combined report (most-severe first, stable kit + node-name tiebreak — the SAME ordering
    // `analyze` uses). Render errors (severity 5) sort to the top.
    findings.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.kit.cmp(&b.kit))
            .then_with(|| a.node_names.first().cmp(&b.node_names.first()))
    });

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

/// `bsc ui dupes` (#3544) — the whole-library duplicate report: the exact `duplicate` findings the per-kit
/// analyzer emits (shared `wraps` / byte-identical source) PLUS the fuzzy NEAR-duplicates it misses (name +
/// contract distance — `Donut`≈`DonutChart`, cross-kit `Card` repeats), ranked together. The LLM-native
/// "what should I merge?" surface; PROPOSE-ONLY — the proposals guide a manual/designer merge, there is no
/// `--fix` here. `--kit` scopes to one kit (dropping cross-kit near-dups); `--threshold <0..1>` tunes the
/// fuzzy bar (default [`crate::similarity::DEFAULT_THRESHOLD`]).
fn cmd_dupes(args: &[String]) -> Result<(), String> {
    let (mut dir, mut kit, mut json, mut pretty) = (None::<String>, None::<String>, false, false);
    let mut explain = false;
    let mut threshold = crate::similarity::DEFAULT_THRESHOLD;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--kit" => kit = it.next().cloned(),
            "--threshold" => {
                threshold = it
                    .next()
                    .and_then(|s| s.parse::<f64>().ok())
                    .ok_or("--threshold needs a number in [0,1]")?;
            }
            "--explain" => explain = true,
            "--json" => json = true,
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
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
    // Conflicts first (#4138 — a `provides` collision has a definite answer), then exact duplicates
    // (certain — shared wraps / byte-identical), then the ranked near-duplicates.
    let mut findings: Vec<crate::graph_health::Finding> = crate::similarity::provides_collision_findings(&comps);
    findings.extend(
        crate::graph_health::analyze(&comps).into_iter().filter(|f| f.category == "duplicate"),
    );
    findings.extend(crate::similarity::near_duplicate_findings(&comps, threshold));
    if json {
        let arr: Vec<serde_json::Value> = findings.iter().map(crate::graph_health::Finding::to_value).collect();
        let out = if pretty { serde_json::to_string_pretty(&arr) } else { serde_json::to_string(&arr) };
        println!("{}", out.map_err(|e| e.to_string())?);
        return Ok(());
    }
    if findings.is_empty() {
        println!("✓ no duplicates or near-duplicates found.");
        return Ok(());
    }
    println!("{} duplicate / near-duplicate finding(s), most-similar first:", findings.len());
    let by_id: std::collections::BTreeMap<&str, &serde_json::Value> = comps
        .iter()
        .filter_map(|c| c.get("id").and_then(serde_json::Value::as_str).map(|id| (id, c)))
        .collect();
    for f in &findings {
        println!("  [{}] {} — {}", f.category, f.kit, f.why);
        println!("        → {}", f.suggested_action);
        // #4138: WHY it ranked, not just that it did. Only a two-record finding has a pair to explain;
        // a `provides` collision spanning three is a conflict, not a scored pair.
        if !explain || f.node_ids.len() != 2 {
            continue;
        }
        let (Some(a), Some(b)) = (by_id.get(f.node_ids[0].as_str()), by_id.get(f.node_ids[1].as_str())) else {
            continue;
        };
        let Some(terms) = crate::similarity::explain_pair(a, b) else { continue };
        let (mut scored, mut dropped) = (Vec::new(), Vec::new());
        for t in &terms {
            match t.value {
                // A term with no signal on EITHER side is DROPPED, not scored 0 — naming them is half
                // the point of the explanation, since an absent signal reads as disagreement otherwise.
                None => dropped.push(t.label),
                Some(v) => scored.push(format!("{}={v:.2}×{:.2}→{:.3}", t.label, t.weight, t.contribution())),
            }
        }
        println!("        · terms: {}", scored.join("  "));
        if !dropped.is_empty() {
            println!("        · no signal (dropped): {}", dropped.join(", "));
        }
    }
    Ok(())
}

/// `bsc ui similar <id> [--top N] [--threshold F]` (#3544) — the components most similar to <id> across the
/// WHOLE library (name + contract distance), ranked most-similar first. The discover-before-authoring read:
/// a session checks whether a component like the one it is about to build already exists. Cross-kit;
/// PROPOSE-ONLY. `--top` caps the rows (default 10); `--threshold` sets a minimum overall score.
fn cmd_similar(args: &[String]) -> Result<(), String> {
    let (mut dir, mut json, mut pretty) = (None::<String>, false, false);
    let (mut id, mut top, mut floor) = (None::<String>, 10usize, 0.0f64);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--top" => {
                top = it.next().and_then(|s| s.parse::<usize>().ok()).ok_or("--top needs a positive integer")?;
            }
            "--threshold" => {
                floor = it.next().and_then(|s| s.parse::<f64>().ok()).ok_or("--threshold needs a number in [0,1]")?;
            }
            "--json" => json = true,
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other if id.is_none() => id = Some(other.to_string()),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let id = id.ok_or("usage: bsc ui similar <id> [--top N] [--threshold F]")?;
    let store = open_component_store(&dir)?;
    let comps: Vec<serde_json::Value> =
        store.list().iter().filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok()).collect();
    if !comps.iter().any(|c| c.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())) {
        return Err(format!("no component with id '{id}' (see `bsc ui list --raw`)"));
    }
    // #3584: fold each candidate's graph-USAGE (composes-inverse) into the row, so a "these two overlap"
    // proposal arrives with which side is load-bearing — the optimizer folds the LESS-used into the more.
    let idx = used_by_index(&comps);
    let rows: Vec<serde_json::Value> = crate::similarity::rank_similar(&id, &comps, top, floor)
        .into_iter()
        .map(|mut r| {
            let key = (r["kit"].as_str().unwrap_or("").to_string(), r["name"].as_str().unwrap_or("").to_string());
            r["usedBy"] = serde_json::Value::from(idx.get(&key).map_or(0, Vec::len));
            r
        })
        .collect();
    if json {
        let out = if pretty { serde_json::to_string_pretty(&rows) } else { serde_json::to_string(&rows) };
        println!("{}", out.map_err(|e| e.to_string())?);
        return Ok(());
    }
    if rows.is_empty() {
        println!("no components similar to '{id}'.");
        return Ok(());
    }
    println!("components similar to '{id}', most-similar first:");
    for r in &rows {
        println!(
            "  {:>3.0}%  {} ({})  [name {:.2} · contract {:.2} · used-by {}]",
            r["score"].as_f64().unwrap_or(0.0) * 100.0,
            r["name"].as_str().unwrap_or(""),
            r["kit"].as_str().unwrap_or(""),
            r["name_similarity"].as_f64().unwrap_or(0.0),
            r["contract_similarity"].as_f64().unwrap_or(0.0),
            r["usedBy"].as_u64().unwrap_or(0),
        );
    }
    Ok(())
}

/// The composes-INVERSE (#3584): for each `(kitId, name)`, the sorted+deduped names of same-kit components
/// that list it in `composes`. The graph-internal USAGE signal — how load-bearing a component is within its
/// kit — keyed by `(kit, name)` because `composes` resolves by NAME and a name can recur across kits (kits
/// never cross, so a `Button` in kit A and one in kit B are distinct). Computed live from the records, so
/// it is never a placeholder (unlike the codebase-usage `used` field).
fn used_by_index(
    components: &[serde_json::Value],
) -> std::collections::BTreeMap<(String, String), Vec<String>> {
    let mut idx: std::collections::BTreeMap<(String, String), Vec<String>> = std::collections::BTreeMap::new();
    for c in components {
        let kit = c.get("kitId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let Some(composer) = c.get("name").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()) else {
            continue;
        };
        for dep in c.get("composes").and_then(serde_json::Value::as_array).into_iter().flatten() {
            if let Some(dep_name) = dep.as_str().filter(|s| !s.is_empty()) {
                idx.entry((kit.clone(), dep_name.to_string())).or_default().push(composer.to_string());
            }
        }
    }
    for composers in idx.values_mut() {
        composers.sort();
        composers.dedup();
    }
    idx
}

/// `bsc ui used-by <id>` / `--all` (#3584) — the graph-usage read (composes-inverse). A READ verb, never
/// scope-gated. Single form: one component's composers + count. `--all`: every component ranked by usage,
/// most-used first (`--kit` scopes to one kit) — the whole-library "what is load-bearing" view.
fn cmd_used_by(args: &[String]) -> Result<(), String> {
    let (mut dir, mut json, mut pretty, mut all, mut kit_filter, mut id) =
        (None::<String>, false, false, false, None::<String>, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--all" => all = true,
            "--kit" => kit_filter = it.next().cloned(),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other if id.is_none() => id = Some(other.to_string()),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let store = open_component_store(&dir)?;
    let comps: Vec<serde_json::Value> =
        store.list().iter().filter_map(|j| serde_json::from_str::<serde_json::Value>(j).ok()).collect();
    let idx = used_by_index(&comps);
    let count_of = |c: &serde_json::Value| -> usize {
        let key = (
            c.get("kitId").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
            c.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        );
        idx.get(&key).map_or(0, Vec::len)
    };

    if all {
        // Whole-library ranking, most-used first (id tiebreak for order-stability).
        let mut rows: Vec<serde_json::Value> = comps
            .iter()
            .filter(|c| kit_filter.as_deref().is_none_or(|k| c.get("kitId").and_then(serde_json::Value::as_str) == Some(k)))
            .map(|c| serde_json::json!({
                "id": c.get("id").and_then(serde_json::Value::as_str).unwrap_or(""),
                "name": c.get("name").and_then(serde_json::Value::as_str).unwrap_or(""),
                "kit": c.get("kitId").and_then(serde_json::Value::as_str).unwrap_or(""),
                "count": count_of(c),
            }))
            .collect();
        rows.sort_by(|a, b| {
            b["count"].as_u64().cmp(&a["count"].as_u64()).then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
        });
        if json {
            let out = if pretty { serde_json::to_string_pretty(&rows) } else { serde_json::to_string(&rows) };
            println!("{}", out.map_err(|e| e.to_string())?);
        } else {
            println!("components by graph usage (composes-inverse), most-used first:");
            for r in &rows {
                println!("  {:>3}  {} ({})", r["count"].as_u64().unwrap_or(0), r["name"].as_str().unwrap_or(""), r["kit"].as_str().unwrap_or(""));
            }
        }
        return Ok(());
    }

    let id = id.ok_or("usage: bsc ui used-by <id> [--json]  |  bsc ui used-by --all [--kit K]")?;
    let target = comps
        .iter()
        .find(|c| c.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()))
        .ok_or_else(|| format!("no component with id '{id}' (see `bsc ui list --raw`)"))?;
    let key = (
        target.get("kitId").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
        target.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
    );
    let composers = idx.get(&key).cloned().unwrap_or_default();
    let out = serde_json::json!({
        "id": id,
        "name": key.1,
        "kit": key.0,
        "usedBy": composers,
        "count": composers.len(),
    });
    if json {
        let text = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
        println!("{}", text.map_err(|e| e.to_string())?);
    } else if composers.is_empty() {
        println!("'{}' ({}) is composed by NOTHING in its kit — an orphan candidate (used-by 0).", key.1, key.0);
    } else {
        println!("'{}' ({}) is composed by {} component(s): {}", key.1, key.0, composers.len(), composers.join(", "));
    }
    Ok(())
}

/// The `doctor --fix` optimize action (#2679, #3089 merge) — the curator's mechanical, SAFE graph
/// optimization as a COMMAND (epic #3087: 'keep the graph minimal' is a tool, not hand-organization).
/// Two lossless steps, dry-run unless `apply`:
///   1. MERGE byte-identical duplicates (`graph_health::merge_plan`) — fold each group into the
///      most-`used` canonical, repointing composers; only byte-identical, never a same-`wraps` dup.
///   2. PRUNE the GUARDED dead roots (`graph_health::prune_plan`) — orphan/dead-root only, never a
///      `used > 0`, and never a `page` / packaged built-in / anything at all while the usage index is
///      unpopulated (#3087). A guarded candidate is still reported, just never auto-removed.
///
/// Cycles + same-`wraps` (differing-source) duplicates need the curator's SEMANTIC call, so they're only
/// surfaced as a note — never auto-resolved here.
fn doctor_fix(store: &bsc_json_store::Store, comps: &[serde_json::Value], apply: bool) -> Result<(), String> {
    let plan = crate::graph_health::merge_plan(comps);
    // Dead roots to prune, minus anything a merge already removes (never double-handle an id).
    let merged_ids: std::collections::BTreeSet<String> =
        plan.groups.iter().flat_map(|g| g.removed.iter().map(|(id, _)| id.clone())).collect();
    let prune_plan = crate::graph_health::prune_plan(comps);
    let prunable: Vec<_> =
        prune_plan.prune.into_iter().filter(|p| !merged_ids.contains(&p.id)).collect();
    let skipped = prune_plan.skipped;
    let cycles = crate::graph_health::analyze(comps).iter().filter(|f| f.category == "cycle").count();
    let manual_note = || {
        if cycles > 0 {
            println!("  ({cycles} cycle(s) need a manual break; same-`wraps` duplicates need the curator's semantic call — see `bsc ui doctor`).");
        }
    };
    // #3087: the guards are LOUD — a withheld candidate is named with the guard that saved it, so the
    // report never silently shrinks and a genuine dead page/seed is still visible to the human.
    let guard_note = || {
        if skipped.is_empty() {
            return;
        }
        println!(
            "  {} dead-root finding(s) HELD BACK by the prune guards (#3087) — still reported by `bsc ui doctor`, never auto-removed:",
            skipped.len()
        );
        for s in &skipped {
            println!("    · {} ({}) — {}", s.name, s.id, s.guard);
        }
    };

    if plan.groups.is_empty() && prunable.is_empty() {
        if skipped.is_empty() {
            println!("✓ nothing to auto-optimize — no byte-identical duplicates and no dead roots.");
        } else {
            println!("✓ nothing SAFE to auto-optimize — no byte-identical duplicates, and every dead-root candidate is guarded.");
        }
        guard_note();
        manual_note();
        return Ok(());
    }

    if !apply {
        if !plan.groups.is_empty() {
            println!("DRY RUN — {} byte-identical duplicate group(s) WOULD be merged (pass --yes to apply):", plan.groups.len());
            for g in &plan.groups {
                let names: Vec<&str> = g.removed.iter().map(|(_, n)| n.as_str()).collect();
                println!("  merge {} → {} ({})", names.join(", "), g.canonical_name, g.canonical_id);
            }
            if !plan.repoints.is_empty() {
                println!("  ({} composer(s) would repoint to the canonical)", plan.repoints.len());
            }
        }
        if !prunable.is_empty() {
            println!("DRY RUN — {} dead node(s) WOULD be pruned:", prunable.len());
            for p in &prunable {
                println!("  - {} ({}) — {}", p.name, p.id, p.reason);
            }
        }
        guard_note();
        manual_note();
        return Ok(());
    }

    // APPLY — merge first (repoint composers, then drop the dups), then prune dead roots. A repoint IS
    // a record edit, so stamp it (#3164): bump rev + updatedAt + updatedBy (writer from $BSC_UI_WRITER,
    // else "unknown"), like every other `bsc ui` write.
    let writer = crate::record::resolve_writer(None);
    for (id, rec) in &plan.repoints {
        stamped_set(store, id, rec.clone(), &writer)?;
    }
    let mut merged = 0usize;
    for g in &plan.groups {
        for (id, name) in &g.removed {
            store.remove(id)?;
            println!("merged {name} ({id}) → {}", g.canonical_name);
            merged += 1;
        }
    }
    let mut pruned = 0usize;
    for p in &prunable {
        store.remove(&p.id)?;
        println!("pruned {} ({})", p.name, p.id);
        pruned += 1;
    }
    println!("optimized: merged {merged} duplicate(s), pruned {pruned} dead node(s). Re-run `bsc ui doctor` — an optimization can surface more.");
    guard_note();
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

// ── preview observability (#3165) ─────────────────────────────────────────────────────────────────
//
// Two custom verbs make the Design Studio's build-and-iframe preview inspectable from a session's shell:
//   • `preview-props` prints the schema-derived sample props the harness passes a component, per state —
//     the pure sampler (`crate::preview_props`) mirrors the TS `samplePropValue`/`bootstrapSource`, pinned
//     to it by a shared golden fixture (both sides assert it).
//   • `preview-error` / `preview-errors` are the write/read of a durable JSONL log the frontend appends to
//     when the sandboxed iframe posts `{__preview:"error"}` (`crate::preview_errors`) — so a preview
//     runtime throw is observable, not just an ephemeral in-pane banner.

/// `preview-props <id> [--state S] [--dir D] [--pretty]` (#3165) — print the schema-derived sample props
/// the live preview harness passes <id>'s component, per data-state. A read verb (never scope-gated).
fn cmd_preview_props(args: &[String]) -> Result<(), String> {
    let (mut dir, mut pretty, mut state, mut id) = (None::<String>, false, None::<String>, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--state" => state = it.next().cloned(),
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional => id = Some(positional.to_string()),
        }
    }
    let id = id.ok_or("usage: preview-props <id> [--state loaded|empty|loading] [--pretty]")?;
    if let Some(s) = &state {
        if !matches!(s.as_str(), "loaded" | "empty" | "loading") {
            return Err(format!("unknown state '{s}' — one of loaded | empty | loading"));
        }
    }
    let store = open_component_store(&dir)?;
    let raw = store.get(&id)?.ok_or_else(|| format!("no component '{id}'"))?;
    // #3545: inspecting a component's preview props FOCUSES it in the Design Studio (a `ui-focus`, so the
    // preview follows Claude's working focus). A read → no re-hydrate. No-op off a designer session.
    bsc_util::emit_ui_focus("component", &id);
    let rec: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let name = rec.get("name").and_then(serde_json::Value::as_str).unwrap_or(&id);
    let role = rec.get("role").and_then(serde_json::Value::as_str).unwrap_or("");
    let props = crate::preview_props::props_from_record(&rec);
    let mut states = crate::preview_props::preview_props_states(name, &props);
    // --state narrows the states object to just the one requested (the shape stays `{ <state>: {…} }`).
    if let Some(s) = &state {
        let picked = states.get(s).cloned().unwrap_or(serde_json::Value::Null);
        states = serde_json::json!({ s: picked });
    }
    let out = serde_json::json!({ "id": id, "name": name, "role": role, "states": states });
    let json = if pretty { serde_json::to_string_pretty(&out) } else { serde_json::to_string(&out) };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// `preview-errors [-n N] [--pretty]` (#3165) — tail the last N captured preview runtime errors. Read-only.
fn cmd_preview_errors(args: &[String]) -> Result<(), String> {
    let (mut n, mut pretty) = (20usize, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-n" | "--limit" => {
                n = it.next().and_then(|v| v.parse().ok()).ok_or("-n needs a number")?;
            }
            "--pretty" => pretty = true,
            other if other.starts_with('-') => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let arr = serde_json::Value::Array(crate::preview_errors::tail(n));
    let json = if pretty { serde_json::to_string_pretty(&arr) } else { serde_json::to_string(&arr) };
    println!("{}", json.map_err(|e| e.to_string())?);
    Ok(())
}

/// `preview-error <id>` (#3165) — append a preview-error record (message read from stdin) to the durable
/// log `preview-errors` tails. A diagnostic append, so NOT ui-scope gated.
fn cmd_preview_error(args: &[String]) -> Result<(), String> {
    // #3737: `preview-error clear <id>` clears a stale render-error directly (without re-writing the
    // component), for when the recorded error no longer reflects the current source. Everything else is
    // the RECORD form: `preview-error <id>` with the message on stdin.
    if args.first().map(String::as_str) == Some("clear") {
        let id = args.get(1).ok_or("usage: preview-error clear <id>")?;
        crate::preview_errors::clear(id)?;
        println!("{id}");
        return Ok(());
    }
    let id = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .ok_or("usage: preview-error <id>   # error message / stack trace on stdin (or `clear <id>`)")?;
    let mut message = String::new();
    std::io::stdin().read_to_string(&mut message).map_err(|e| format!("cannot read stdin: {e}"))?;
    crate::preview_errors::record(id, message.trim())?;
    println!("{id}");
    Ok(())
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
    // Stamp the write like every other `bsc ui` mutation (#3164): bump rev + updatedAt + updatedBy
    // (writer from $BSC_UI_WRITER, else "unknown" — the animation verbs take no --by).
    stamped_set(store, id, record, &crate::record::resolve_writer(None))
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
    // Stamp the write like every other `bsc ui` mutation (#3164).
    stamped_set(store, id, record, &crate::record::resolve_writer(None))
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

/// Gather the authored motion (kit libraries + component INLINE defs) into flat AnimationDefs and compile
/// them to CSS (#3163). KIT-level animations emit un-namespaced (`bsc-<kit>-<name>`); a component's inline
/// animations are NAMESPACED by the owning component (`bsc-<kit>-<component>-<name>`) so two components'
/// same-named animations don't collide. A name-ref string on a component points at the kit's shared
/// library (already emitted from the kit pass), so only object entries are taken here. `kit` scopes to one
/// kit id. Pure over the two stores → driven directly by tests.
fn collect_motion_css(
    kit: Option<&str>,
    kit_store: &bsc_json_store::Store,
    comp_store: &bsc_json_store::Store,
) -> String {
    let scoped = |kit_id: &str| kit.is_none_or(|k| k == kit_id);
    let mut defs: Vec<serde_json::Value> = Vec::new();

    // KIT-level motion libraries → `bsc-<kit>-<name>` (no component namespace).
    for raw in kit_store.list() {
        let Ok(k) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let kit_id = k.get("id").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !scoped(kit_id) {
            continue;
        }
        if let Some(anims) = k.get("animations").and_then(serde_json::Value::as_array) {
            for a in anims {
                if let Some(def) = crate::motion::anim_def(a, kit_id, None) {
                    defs.push(def);
                }
            }
        }
    }

    // COMPONENT INLINE motion → namespaced by the owning component (#3163).
    for raw in comp_store.list() {
        let Ok(c) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let kit_id = c.get("kitId").and_then(serde_json::Value::as_str).unwrap_or_default();
        if !scoped(kit_id) {
            continue;
        }
        let name = c.get("name").and_then(serde_json::Value::as_str).unwrap_or_default();
        if let Some(anims) = c.get("animations").and_then(serde_json::Value::as_array) {
            for a in anims {
                if a.is_object() {
                    if let Some(def) = crate::motion::anim_def(a, kit_id, Some(name)) {
                        defs.push(def);
                    }
                }
            }
        }
    }

    crate::motion::compile_animations_css(&defs)
}

/// `kit emit-motion-css [--kit K]` (#3163) — compile the authored motion (kit libraries + component inline
/// defs) to CSS and print it, so an author can SEE the keyframes/rules/delays instead of guessing from the
/// data. A custom READ over BOTH the kit and component stores (never scope-gated). `--dir`/`--component-dir`
/// override the two store paths (for tests).
fn cmd_emit_motion_css(args: &[String]) -> Result<(), String> {
    let (mut kit, mut kit_dir, mut comp_dir) = (None::<String>, None::<String>, None::<String>);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--kit" => kit = it.next().cloned(),
            "--dir" => kit_dir = it.next().cloned(),
            "--component-dir" => comp_dir = it.next().cloned(),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let kit_store = open_kit_store(&kit_dir)?;
    let comp_store = open_component_store(&comp_dir)?;
    println!("{}", collect_motion_css(kit.as_deref(), &kit_store, &comp_store));
    Ok(())
}

// ── granular writes (#3162) ──────────────────────────────────────────────────────────────────────
//
// `set-src` / `patch` / `get --field`: edit or read ONE field of a component record without a
// whole-record round-trip (and its ~10KB stdin ceiling). Every WRITE path still runs the `set` write-
// time JSX syntax gate (`validate_component_batch`, #2928) so a granular write can't smuggle in a
// module `srcText` that won't build. The core mutations (`replace_src` / `apply_patch`) are pure of
// stdin/print so tests drive them directly; the `cmd_*` wrappers add arg/stdin parsing + the ui-scope
// gate (honored BEFORE stdin/the store are touched, like `doctor --fix`).

/// Normalize a user-supplied JSON pointer: a leading `/` is optional for ergonomics, so `name` and
/// `/name` both address the top-level `name` field (the empty string stays empty — the whole doc).
///
/// Rejects a pointer that git-bash's MSYS path conversion has REWRITTEN. Any argument starting with `/`
/// is treated by MSYS as a unix path and rewritten to the git install root — so `--field /name` reaches
/// the process as `C:/Program Files/Git/name`. The old failure was `no field 'C:/Program Files/Git/name'`,
/// which reads as a missing field and sent a caller hunting for the wrong thing; the studio sessions run
/// in git-bash, so every pointer they passed the documented way silently mis-addressed (#3383).
///
/// We ERROR rather than recover: the mangled form is `<install-root><pointer>` and the root's length is
/// not knowable in-process, so stripping it would be a guess at WHICH field was meant — and a wrong guess
/// on `patch` writes the wrong field. A drive-letter prefix is an unambiguous tell (no legitimate pointer
/// token starts with `C:`), so this only ever fires on genuine damage, and it names the fix.
fn normalize_pointer(p: &str) -> Result<String, String> {
    let b = p.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\') {
        // Deliberately NOT reconstructing the intended pointer: the mangled form is
        // `<install-root><pointer>` and the root's length is unknowable here, so any tail we picked
        // would be a guess — and naming the wrong field on `patch` steers a wrong WRITE. State the
        // rule instead; the caller knows which field they meant.
        return Err(format!(
            "'{p}' is not a JSON pointer — a leading '/' was rewritten by git-bash path conversion.\n\
             Re-run WITHOUT the leading slash (`name`, `animations/1`), not with it (`/name`). The \
             leading '/' is optional everywhere a pointer is taken, and the slash-free form is never \
             rewritten.\n\
             Do NOT prefix the command with MSYS_NO_PATHCONV=1 — a restricted session cannot run an \
             environment-variable assignment."
        ));
    }
    Ok(if p.is_empty() || p.starts_with('/') { p.to_string() } else { format!("/{p}") })
}

/// Set `value` at the RFC-6901 JSON pointer `pointer` within `root`, replacing (or inserting, for an
/// object key or an array append slot) exactly that one field. The pointer's PARENT container must
/// already exist — this is a granular field write, not a deep-create. An array token is a numeric index
/// (which may equal the length to append) or `-` (push). Escapes: `~1`→`/`, `~0`→`~`. Pure → unit-tested.
fn set_at_pointer(root: &mut serde_json::Value, pointer: &str, value: serde_json::Value) -> Result<(), String> {
    use serde_json::Value;
    let tokens: Vec<String> = if pointer.is_empty() {
        Vec::new()
    } else {
        pointer[1..].split('/').map(|t| t.replace("~1", "/").replace("~0", "~")).collect()
    };
    let Some((last, parents)) = tokens.split_last() else {
        // An empty pointer would replace the whole record — refuse (patch is a FIELD write).
        return Err("a JSON pointer must name at least one field (e.g. `/name`)".to_string());
    };
    // Walk to the parent container; each intermediate level must already exist.
    let mut cur = root;
    for tok in parents {
        cur = match cur {
            Value::Object(map) => map
                .get_mut(tok)
                .ok_or_else(|| format!("no object key '{tok}' along the pointer '{pointer}'"))?,
            Value::Array(arr) => {
                let i: usize =
                    tok.parse().map_err(|_| format!("pointer token '{tok}' is not a valid array index"))?;
                arr.get_mut(i).ok_or_else(|| format!("array index {i} out of range along '{pointer}'"))?
            }
            _ => return Err(format!("pointer '{pointer}' descends into a non-container at '{tok}'")),
        };
    }
    // Set the final token on the parent container.
    match cur {
        Value::Object(map) => {
            map.insert(last.clone(), value);
            Ok(())
        }
        Value::Array(arr) => {
            if last == "-" {
                arr.push(value);
                return Ok(());
            }
            let i: usize = last
                .parse()
                .map_err(|_| format!("pointer token '{last}' is not a valid array index (or `-` to append)"))?;
            match i.cmp(&arr.len()) {
                std::cmp::Ordering::Less => {
                    arr[i] = value;
                    Ok(())
                }
                std::cmp::Ordering::Equal => {
                    arr.push(value);
                    Ok(())
                }
                std::cmp::Ordering::Greater => Err(format!(
                    "array index {i} is out of range (len {}) — a patch cannot leave holes",
                    arr.len()
                )),
            }
        }
        _ => Err(format!("cannot set '{last}': the parent along '{pointer}' is not an object or array")),
    }
}

/// Replace ONLY component `id`'s `srcText` with `src`, leaving every other field untouched, then run the
/// SAME write-time JSX syntax gate as `set` (#2928) before writing. The write funnels through
/// [`stamped_set`] so it bumps `rev`/`updatedAt`/`updatedBy` like every other `bsc ui` mutation (#3164).
/// Errors when the component is absent. Pure of stdin/print so tests drive it directly.
fn replace_src(store: &bsc_json_store::Store, id: &str, src: &str) -> Result<(), String> {
    let mut record = load_component_object(store, id)?;
    record
        .as_object_mut()
        .expect("load_component_object guarantees an object")
        .insert("srcText".to_string(), serde_json::Value::String(src.to_string()));
    validate_component_batch(std::slice::from_ref(&record))?;
    stamped_set(store, id, record, &crate::record::resolve_writer(None))?;
    // #3737: `set-src` invalidates the last render — clear any stale `render-error` so `bsc ui doctor`
    // doesn't keep reporting the pre-edit throw (batch `set` already does this, #43; set-src/patch didn't,
    // which is how the #11/#21 stale errors survived). Best-effort; a no-op unless this id has an error.
    let _ = crate::preview_errors::clear(id);
    Ok(())
}

/// Set `value` at `pointer` on component `id`'s record, then run the `set` syntax gate (#2928) — so a
/// `patch /srcText …` can't smuggle in a module that won't build. The write funnels through
/// [`stamped_set`] so it bumps `rev`/`updatedAt`/`updatedBy` like every other `bsc ui` mutation (#3164).
/// Errors when the component (or the pointer's parent) is absent. Pure of stdin/print so tests drive it.
fn apply_patch(
    store: &bsc_json_store::Store,
    id: &str,
    pointer: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut record = load_component_object(store, id)?;
    set_at_pointer(&mut record, &normalize_pointer(pointer)?, value)?;
    validate_component_batch(std::slice::from_ref(&record))?;
    stamped_set(store, id, record, &crate::record::resolve_writer(None))?;
    // #3737: a component patch invalidates the last render — clear any stale `render-error` (see `replace_src`).
    let _ = crate::preview_errors::clear(id);
    Ok(())
}

/// Render ONE resolved field value for `get --field` to the string to emit: `raw` unwraps a string (no
/// quotes/escaping) so a shell capture is clean — a non-string value still prints as compact JSON;
/// otherwise JSON (pretty indents). The raw string is EMITTED via the shared [`bsc_cli_util::print_raw`]
/// (#3166) by the caller, so `--field --raw` is byte-identical to the whole-record `--raw`. Pure → unit-tested.
fn field_output(value: &serde_json::Value, raw: bool, pretty: bool) -> Result<String, String> {
    if raw {
        return Ok(match value {
            serde_json::Value::String(s) => s.clone(),
            other => serde_json::to_string(other).map_err(|e| e.to_string())?,
        });
    }
    if pretty {
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())
    } else {
        serde_json::to_string(value).map_err(|e| e.to_string())
    }
}

/// `set-src <id> [--dir D]` (#3162) — replace ONLY component <id>'s `srcText` from stdin. A ui-scope
/// MUTATION: the write-scope is honored BEFORE stdin/the store are touched (so a read-scoped session
/// refuses immediately without blocking on stdin).
fn cmd_set_src(args: &[String]) -> Result<(), String> {
    let (pos, dir, _pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or("usage: bsc ui set-src <id>   # the new srcText on stdin")?;
    bsc_cli_util::require_write_scope("ui")?;
    let mut src = String::new();
    std::io::stdin().read_to_string(&mut src).map_err(|e| format!("cannot read stdin: {e}"))?;
    let store = open_component_store(&dir)?;
    replace_src(&store, id, &src)?;
    bsc_util::emit_ui_activity("component", id);
    println!("{id}");
    Ok(())
}

/// `patch <id> <json-pointer> <value> [--dir D]` (#3162) — set ONE field by JSON pointer, parsing
/// <value> as JSON (else a bare string). A ui-scope MUTATION (gated before the store is touched).
fn cmd_patch(args: &[String]) -> Result<(), String> {
    const USAGE: &str = "usage: bsc ui patch <id> <json-pointer> <value>";
    let (pos, dir, _pretty) = parse_anim_args(args)?;
    let id = pos.first().ok_or(USAGE)?;
    let pointer = pos.get(1).ok_or(USAGE)?;
    let raw_value = pos.get(2).ok_or(USAGE)?;
    bsc_cli_util::require_write_scope("ui")?;
    // JSON when it parses, else a bare string (so `/name Button` stores "Button" without the quotes).
    let value: serde_json::Value = serde_json::from_str(raw_value)
        .unwrap_or_else(|_| serde_json::Value::String(raw_value.clone()));
    let store = open_component_store(&dir)?;
    apply_patch(&store, id, pointer, value)?;
    bsc_util::emit_ui_activity("component", id);
    println!("{id}");
    Ok(())
}

/// `get <id> [--field <json-pointer>] [--raw] [--dir D] [--pretty] [--out <name>]` — the read verbs this
/// crate intercepts (the shared store CLI rejects the extra flags). Prints the whole record, or ONE
/// `--field` resolved by JSON pointer (#3162), to stdout — OR, with `--out <name>`, writes the exact same
/// bytes into `$BSC_SCRATCH/<name>` (#3713) and prints that path. A read verb (never scope-gated); errors
/// when the component OR the `--field` is absent.
///
/// **Why `--out` exists:** a restricted studio session truncates large stdout (~30KB) and spills the
/// remainder to a path OUTSIDE the confinement, which the FS hook then blocks Read/Grep from opening — so a
/// large `srcText` (e.g. a 538-line page) can't be reviewed via stdout at all. `--out` lands it in the
/// scratch dir, a confinement-allowed path the session Reads in full regardless of size.
fn cmd_get(args: &[String]) -> Result<(), String> {
    let (mut id, mut dir, mut field, mut out, mut kit) =
        (None::<String>, None::<String>, None::<String>, None::<String>, None::<String>);
    let (mut raw, mut pretty) = (false, false);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--field" => field = it.next().cloned(),
            "--out" => out = it.next().cloned(),
            "--kit" => kit = it.next().cloned(),
            "--raw" => raw = true,
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            positional if id.is_none() => id = Some(positional.to_string()),
            other => return Err(format!("unexpected argument '{other}'")),
        }
    }
    let id = id.ok_or("usage: bsc ui get <id> [--field <json-pointer>] [--kit <kitId>] [--raw] [--out <name>]")?;
    let store = open_component_store(&dir)?;
    let record = load_component_object(&store, &id)?;
    // #3729: `--kit <kitId>` disambiguates. The store is keyed by id ALONE, so there is exactly ONE
    // record per id — this asserts WHICH kit it belongs to (a designer who harvested a same-named
    // component into another kit believed two coexisted). Errors, naming the ACTUAL kit, on a mismatch.
    if let Some(want_kit) = &kit {
        let actual = record.get("kitId").and_then(serde_json::Value::as_str).unwrap_or_default();
        if actual != want_kit {
            return Err(format!(
                "component '{id}' is in kit '{actual}', not '{want_kit}' — the store is keyed by id, so there is exactly one '{id}' (the last write wins)"
            ));
        }
    }
    // The value to render: one `--field`, else the whole record. `field_output` handles both a scalar
    // field and a whole object uniformly (raw string-unwraps, else compact/pretty JSON).
    let text = match &field {
        Some(f) => {
            let value = record
                .pointer(&normalize_pointer(f)?)
                .ok_or_else(|| format!("no field '{f}' in component '{id}'"))?;
            field_output(value, raw, pretty)?
        }
        None => {
            // A whole-record read follows Claude's working focus in the studio (#3545), matching the
            // plain `get <id>`; a `--field` read does not (it's an inspection of one attribute).
            bsc_util::emit_ui_focus("component", &id);
            field_output(&record, raw, pretty)?
        }
    };
    match out {
        // Spill to the sealed scratch dir — same bytes stdout would carry: raw ⇒ the #3166 LF-only,
        // CR-stripped, single-trailing-LF form; non-raw ⇒ the value + one newline (like `println!`).
        Some(name) => {
            let path = bsc_cli_util::resolve_scratch_out(&name)?;
            let bytes = if raw { bsc_cli_util::raw_line(&text) } else { format!("{text}\n") };
            std::fs::write(&path, bytes.as_bytes())
                .map_err(|e| format!("cannot write --out {}: {e}", path.display()))?;
            // Report the absolute path so the session knows exactly what to Read next.
            println!("{}", path.display());
        }
        None if raw => {
            // Compose with the shared #3166 raw printer so `--field --raw` behaves IDENTICALLY to the
            // whole-record `--raw`: LF-only (CR-stripped), bytes-direct (no locale layer), one trailing LF.
            bsc_cli_util::print_raw(&text);
        }
        None => println!("{text}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #3606 — export dumps the store to a folder tree nested by `group`, import loads it back, and the
    /// round-trip is lossless; a kit BUNDLE ({components:[…]}, e.g. react-ui.json) is exploded on import.
    #[test]
    fn export_import_round_trips_a_folder_tree_and_explodes_a_bundle() {
        let base = std::env::temp_dir().join(format!("bsc-comp-io-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let store_dir = base.join("store");
        let tree = base.join("tree");
        std::fs::create_dir_all(&store_dir).unwrap();
        let store = bsc_json_store::Store::new(store_dir.clone(), "component");
        // One nested-by-group component, one ungrouped.
        store.set("card", r#"{"id":"card","name":"Card","group":"ui/data","srcText":"export const Card=()=>null;"}"#).unwrap();
        store.set("loose", r#"{"id":"loose","name":"Loose","srcText":"export const Loose=()=>null;"}"#).unwrap();

        // export → files nest by the `group` folder path; ungrouped sits at the root.
        cmd_export(&["--dir".into(), store_dir.to_string_lossy().into_owned(), tree.to_string_lossy().into_owned()]).unwrap();
        assert!(tree.join("ui/data/card.json").exists(), "grouped component nests by its folder path");
        assert!(tree.join("loose.json").exists(), "ungrouped component sits at the tree root");

        // wipe the store, then import the tree back — lossless.
        store.remove("card").unwrap();
        store.remove("loose").unwrap();
        assert_eq!(store.list().len(), 0, "store cleared before re-import");
        cmd_import(&["--dir".into(), store_dir.to_string_lossy().into_owned(), tree.to_string_lossy().into_owned()]).unwrap();
        let card: serde_json::Value = serde_json::from_str(&store.get("card").unwrap().unwrap()).unwrap();
        assert_eq!(card["group"], "ui/data", "the grouped record imported back verbatim");
        assert_eq!(card["srcText"], "export const Card=()=>null;");
        assert!(store.get("loose").unwrap().is_some(), "the ungrouped record imported back too");

        // a kit bundle file is exploded — every component inside it is imported.
        std::fs::write(tree.join("bundle.json"), r#"{"id":"kit","components":[{"id":"x","name":"X"},{"id":"y","name":"Y"}]}"#).unwrap();
        cmd_import(&["--dir".into(), store_dir.to_string_lossy().into_owned(), tree.to_string_lossy().into_owned()]).unwrap();
        assert!(store.get("x").unwrap().is_some() && store.get("y").unwrap().is_some(), "the bundle's components were exploded in");
        assert!(store.get("kit").unwrap().is_none(), "the bundle wrapper itself is NOT stored as a component");

        let _ = std::fs::remove_dir_all(&base);
    }

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

        // A valid module, a usage-snippet srcText (not a module → warned, then stored), and a record
        // with no srcText all pass — the whole batch is accepted.
        let ok_batch = vec![
            serde_json::json!({ "id": "a", "name": "A", "srcText": "export function A(){ return null; }" }),
            serde_json::json!({ "id": "b", "name": "B", "srcText": "import { B } from \"@/x\";\n<B label={…} />" }),
            serde_json::json!({ "id": "c", "name": "C" }),
        ];
        assert!(validate_component_batch(&ok_batch).is_ok());
    }

    #[test]
    fn validate_component_batch_never_rejects_over_a_jsx_text_escape() {
        // #3709: a `·` in JSX-text position is a semantic-but-valid-JS defect — it must be WARNED
        // (stderr, exercised by the graph_health scanner test), never rejected: the module compiles and
        // stores. The whole batch — the leaky component + its correct `{"·"}` twin — passes.
        let batch = vec![
            serde_json::json!({ "id": "fleet", "name": "FleetPage",
                "srcText": "export function FleetPage(){ return (<span>{count} workers \\u00b7 running</span>); }" }),
            serde_json::json!({ "id": "fixed", "name": "FleetPageFixed",
                "srcText": "export function FleetPageFixed(){ return (<span>{count} workers {\"\\u00b7\"} running</span>); }" }),
        ];
        assert!(validate_component_batch(&batch).is_ok(), "a JSX-text escape is advisory, never a rejection");
    }

    #[test]
    fn suppress_writes_a_tombstone_and_unsuppress_removes_it() {
        // #3725: `suppress` permanently removes a packaged builtin (a plain `remove` re-seeds); `unsuppress`
        // clears the tombstone; `unsuppress` refuses a real record.
        let dir = tmp_store_dir("suppress");
        let store = bsc_json_store::Store::new(dir.clone(), "component");
        store.set("cost", r#"{"id":"cost","name":"CostEnergyView","kitId":"base-studio-code","builtin":true}"#).unwrap();

        run(vec!["suppress".into(), "cost".into(), "--dir".into(), dir.clone()], "bsc ui").unwrap();
        let rec: serde_json::Value = serde_json::from_str(&store.get("cost").unwrap().unwrap()).unwrap();
        assert_eq!(rec["suppressed"], serde_json::Value::Bool(true), "suppress wrote a tombstone: {rec}");

        run(vec!["unsuppress".into(), "cost".into(), "--dir".into(), dir.clone()], "bsc ui").unwrap();
        assert!(store.get("cost").unwrap().is_none(), "unsuppress removed the tombstone");

        // unsuppress REFUSES a non-tombstone — a real record must go through `remove`, never this.
        store.set("real", r#"{"id":"real","name":"Real","kitId":"k"}"#).unwrap();
        let err = run(vec!["unsuppress".into(), "real".into(), "--dir".into(), dir], "bsc ui").unwrap_err();
        assert!(err.contains("not a suppression tombstone"), "{err}");
    }

    #[test]
    fn kit_suppress_routes_through_the_kit_branch() {
        // #3725: `bsc ui kit suppress <id>` writes a tombstone into the KIT store.
        let dir = tmp_store_dir("kit-suppress");
        let store = bsc_json_store::Store::new(dir.clone(), "kit");
        store.set("fleet", r#"{"id":"fleet","name":"Fleet","builtin":true}"#).unwrap();
        run(vec!["kit".into(), "suppress".into(), "fleet".into(), "--dir".into(), dir], "bsc ui").unwrap();
        let rec: serde_json::Value = serde_json::from_str(&store.get("fleet").unwrap().unwrap()).unwrap();
        assert_eq!(rec["suppressed"], serde_json::Value::Bool(true), "kit suppress wrote a tombstone: {rec}");
    }

    #[test]
    fn cross_kit_collision_warns_when_an_id_is_written_under_a_different_kit() {
        // #3729: the store is keyed by id alone, so promoting a same-named component into another kit
        // OVERWRITES the existing one. Warn (naming both kits); a same-kit or new-id write is silent.
        let dir = tmp_store_dir("collision");
        let store = bsc_json_store::Store::new(dir, "component");
        store.set("fleetpage", r#"{"id":"fleetpage","name":"FleetPage","kitId":"base-studio-code"}"#).unwrap();

        let clobber = serde_json::json!({ "id": "fleetpage", "name": "FleetPage", "kitId": "harvested" });
        let ws = cross_kit_collision_warnings(&store, std::slice::from_ref(&clobber));
        assert_eq!(ws.len(), 1, "the cross-kit overwrite warns: {ws:?}");
        assert!(ws[0].contains("base-studio-code") && ws[0].contains("harvested"), "names both kits: {}", ws[0]);

        // Same kit → no warning; a brand-new id → no warning.
        let same = serde_json::json!({ "id": "fleetpage", "name": "FleetPage", "kitId": "base-studio-code" });
        assert!(cross_kit_collision_warnings(&store, std::slice::from_ref(&same)).is_empty(), "same kit is silent");
        let fresh = serde_json::json!({ "id": "newpage", "name": "NewPage", "kitId": "harvested" });
        assert!(cross_kit_collision_warnings(&store, std::slice::from_ref(&fresh)).is_empty(), "a new id is silent");
    }

    #[test]
    fn get_kit_filter_disambiguates_by_kit() {
        // #3729: `get <id> --kit <kitId>` returns the record only if its kitId matches, else errors naming
        // the ACTUAL kit — the store is single-id-keyed, so this confirms which kit the one record is in.
        let dir = tmp_store_dir("get-kit");
        let store = bsc_json_store::Store::new(dir.clone(), "component");
        store.set("fleetpage", r#"{"id":"fleetpage","name":"FleetPage","kitId":"base-studio-code"}"#).unwrap();
        // Matching kit → Ok.
        assert!(
            run(vec!["get".into(), "fleetpage".into(), "--kit".into(), "base-studio-code".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok(),
            "the matching kit resolves",
        );
        // Wrong kit → error naming the ACTUAL kit.
        let err = run(vec!["get".into(), "fleetpage".into(), "--kit".into(), "harvested".into(), "--dir".into(), dir], "bsc ui").unwrap_err();
        assert!(err.contains("is in kit 'base-studio-code'") && err.contains("not 'harvested'"), "{err}");
    }

    #[test]
    fn a_provides_component_with_at_imports_is_syntax_checked_not_warned_as_unbuildable() {
        use serde_json::json;
        // #43: a graph-source component (carries `provides`) has its `@/` imports resolved by the runtime
        // loader — so the gate must NOT emit the false "unresolved first-party @/" advisory for it, and
        // instead runs the real syntax check. A valid one passes.
        let ok = json!({ "id":"box", "name":"Box", "provides":"@/shared/ui/layout/Box",
            "srcText":"import { space } from \"@/shared/ui/layout/space\";\nexport function Box(){ return null; }" });
        assert!(validate_component_batch(std::slice::from_ref(&ok)).is_ok(), "a valid provides-component with @/ imports passes");
        // ...and a CORRUPT one is now caught (before #43 the `@/` import made `looks_buildable_module` false,
        // which skipped syntax-checking entirely, so it stored silently).
        let corrupt = json!({ "id":"box2", "name":"Box2", "provides":"@/shared/ui/layout/Box",
            "srcText":"import { x } from \"@/x\";\nexport const s = [1,2].join(\"\n\");" });
        let err = validate_component_batch(std::slice::from_ref(&corrupt)).unwrap_err();
        assert!(err.contains("Box2"), "a corrupt provides-component is caught, not silently stored: {err}");
    }

    /// #3470 — the two edge rows of the issue's table. The gate used to be INVERTED at its edges: a
    /// `srcText` that keeps its `@/` imports made `looks_buildable_module` false, which skipped the
    /// syntax check ENTIRELY, so the source least like a module got the least validation and stored with
    /// zero complaint. Both rows still STORE (a spec-only record is legitimate) — the fix is that the
    /// outcome is now stated.
    #[test]
    fn a_srctext_that_is_not_a_buildable_module_is_reported_never_silently_skipped() {
        use serde_json::json;

        // ROW 3 — keeps its `@/` imports. Warned, with the reason NAMING the unresolved import and
        // saying what was stored; still accepted.
        let spec = json!({
            "id": "card", "name": "Card",
            "srcText": "import { Button } from \"@/shared/ui/controls/Button\";\nexport const Card = () => <Button />;",
        });
        let src = spec["srcText"].as_str().unwrap();
        assert!(!crate::graph_health::looks_buildable_module(src), "row 3 is not a module…");
        let warning = unbuildable_module_warning(&spec, src);
        assert!(warning.contains("Card"), "names the component: {warning}");
        assert!(warning.contains("@/shared/ui/controls/Button"), "names the unresolved import: {warning}");
        assert!(warning.contains("SPEC"), "states what was stored: {warning}");
        assert!(validate_component_batch(std::slice::from_ref(&spec)).is_ok(), "warn-only — it still stores");

        // ROW 2 — a fragment with no imports IS treated as a module (it has an `export`), so it is NOT
        // warned about and the syntax gate DOES run: a corrupt one is rejected outright.
        let fragment = json!({ "id": "frag", "name": "Frag", "srcText": "export const F = () => <b>hi</b>;" });
        let src = fragment["srcText"].as_str().unwrap();
        assert!(crate::graph_health::looks_buildable_module(src), "a no-import fragment counts as a module");
        assert!(validate_component_batch(std::slice::from_ref(&fragment)).is_ok());
        let corrupt_fragment = json!({ "id": "frag", "name": "Frag", "srcText": "export const s = [1,2].join(\"\n\");" });
        assert!(
            validate_component_batch(std::slice::from_ref(&corrupt_fragment)).is_err(),
            "the syntax gate still runs for a no-import fragment",
        );

        // A record with no srcText at all is neither warned about nor gated.
        let bare = json!({ "id": "c", "name": "C" });
        assert!(validate_component_batch(std::slice::from_ref(&bare)).is_ok());

        // And the #3470 false positive: a component whose only `…` is UI copy is a real module — it must
        // NOT be accused of being a sketch; it goes through the syntax gate like any other module.
        let copy = json!({ "id": "sel", "name": "Select", "srcText": "export const S = () => <input placeholder=\"Select…\" />;" });
        let src = copy["srcText"].as_str().unwrap();
        assert!(crate::graph_health::looks_buildable_module(src), "an ellipsis in COPY is not an elision");
        assert!(validate_component_batch(std::slice::from_ref(&copy)).is_ok());
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
        // Start EMPTY (#3382). `process::id()` is unique among LIVE processes, not over time — the OS
        // recycles pids — and this fixture never cleaned up, so a later run that drew a recycled pid
        // inherited the previous run's store. That surfaced as `a fresh record's first write is rev 1`
        // failing with rev 3: the record was already there at rev 2. Same shape as the env race this
        // issue fixes (state outliving the test that wrote it), different channel — the filesystem.
        // Every tag is used by exactly one test, so wiping here cannot disturb a sibling.
        //
        // BOTH paths must go. The SQLite backend keys off the SIBLING `<dir>.db`, not a file inside
        // `<dir>` (`db_path_for` in bsc-json-store), so removing only the directory leaves the actual
        // database — which is exactly why the first attempt at this fix changed nothing.
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_file(format!("{}.db", d.to_string_lossy()));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    #[test]
    fn specs_are_the_two_collections_with_the_right_lean_fields() {
        assert_eq!(COMPONENT_SPEC.noun, "component");
        assert_eq!(COMPONENT_SPEC.dir_segment, "components");
        // `folder` (#3048/#4107) + `shapes` (#2475) ride the lean list projection so `list`/`list --shape` expose the axes.
        assert_eq!(COMPONENT_SPEC.meta_fields, &["id", "name", "kitId", "role", "folder", "shapes"]);
        assert_eq!(KIT_SPEC.noun, "kit");
        assert_eq!(KIT_SPEC.dir_segment, "kits");
        assert_eq!(KIT_SPEC.meta_fields, &["id", "name", "tech", "style", "stack"]);
        // The two collections live in DIFFERENT dirs (a component and a kit can share an id).
        assert_ne!(COMPONENT_SPEC.dir_segment, KIT_SPEC.dir_segment);
        assert_ne!(COMPONENT_SPEC.dir_env, KIT_SPEC.dir_env);
    }

    #[test]
    fn refolder_rederives_folder_from_src_and_skips_srcless_records() {
        use serde_json::json;
        let dir = tmp_store_dir("regroup");
        let store = open_component_store(&Some(dir.clone())).unwrap();
        // A stale FLAT group + a real src path → must become the folder path.
        store
            .set(
                "button",
                &json!({ "id": "button", "name": "Button", "kitId": "harvested", "role": "primitive",
                         "folder": "controls", "src": "src/shared/ui/controls/Button.tsx" })
                .to_string(),
            )
            .unwrap();
        // A group that ALREADY equals its derived path → left as-is (idempotent, not re-stamped).
        store
            .set(
                "box",
                &json!({ "id": "box", "name": "Box", "kitId": "harvested", "role": "layout",
                         "folder": "shared/ui/layout", "src": "src/shared/ui/layout/Box.tsx" })
                .to_string(),
            )
            .unwrap();
        // No usable `src` → untouched (never bucketed under "").
        store
            .set(
                "stub",
                &json!({ "id": "stub", "name": "Stub", "kitId": "harvested", "role": "primitive" }).to_string(),
            )
            .unwrap();

        cmd_refolder(&["--dir".into(), dir.clone()]).unwrap();

        let group_of = |id: &str| -> Option<String> {
            let raw = store.get(id).unwrap().unwrap();
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
            record_folder(&v).map(str::to_owned)
        };
        assert_eq!(group_of("button").as_deref(), Some("shared/ui/controls"), "flat group → folder path");
        assert_eq!(group_of("box").as_deref(), Some("shared/ui/layout"), "already-correct group unchanged");
        assert_eq!(group_of("stub"), None, "a src-less record stays ungrouped");
    }

    #[test]
    fn refolder_kit_flag_scopes_the_pass_to_one_kit() {
        use serde_json::json;
        let dir = tmp_store_dir("regroup-kit");
        let store = open_component_store(&Some(dir.clone())).unwrap();
        store
            .set(
                "a",
                &json!({ "id": "a", "name": "A", "kitId": "harvested", "role": "primitive",
                         "folder": "old", "src": "src/shared/ui/controls/A.tsx" })
                .to_string(),
            )
            .unwrap();
        store
            .set(
                "b",
                &json!({ "id": "b", "name": "B", "kitId": "react-d3", "role": "composite",
                         "folder": "old", "src": "shared/ui/d3/charts/B.tsx" })
                .to_string(),
            )
            .unwrap();

        cmd_refolder(&["--dir".into(), dir.clone(), "--kit".into(), "harvested".into()]).unwrap();

        let folder_of = |id: &str| -> String {
            let raw = store.get(id).unwrap().unwrap();
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
            record_folder(&v).unwrap().to_owned()
        };
        assert_eq!(folder_of("a"), "shared/ui/controls", "the targeted kit is refoldered");
        assert_eq!(folder_of("b"), "old", "a component in another kit is untouched");
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

    /// #3373 end-to-end: the exact command that was being rejected, now expressed through `--file`.
    ///
    /// The reported failure was `bsc ui kit set --pretty <<'EOF' … EOF` — a heredoc, which the
    /// permission layer splits on newlines into the JSON body and `EOF`, neither of which any rule can
    /// match. `--file` carries the SAME bytes on one allow-listable line. This asserts the payload
    /// survives the round trip verbatim, including the multi-line `srcText` a heredoc existed to carry.
    #[test]
    fn set_reads_the_payload_from_a_bare_named_file_in_the_scratch_dir() {
        let base = std::env::temp_dir().join(format!("bsc-scratch-set-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let scratch = base.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();

        // Real source: newlines, single quotes (which shell-quoting could not survive) and braces.
        let payload = r#"{"id":"kevin/studio","name":"Studio UI","srcText":"export function B(){\n  return <b c='x'/>;\n}"}"#;
        std::fs::write(scratch.join("kit.json"), payload).unwrap();
        bsc_cli_util::with_scratch(scratch.to_str(), || {
        let items = read_set_items("kit", Some("kit.json")).unwrap();
        assert_eq!(items.len(), 1, "one object yields one item, exactly as stdin does");
        assert_eq!(items[0]["id"], "kevin/studio");
        assert_eq!(
            items[0]["srcText"], "export function B(){\n  return <b c='x'/>;\n}",
            "the multi-line source a heredoc existed to carry survives verbatim",
        );

        // The traversal defence reaches this call path, not just the helper's own tests.
        let err = read_set_items("kit", Some("../../../etc/passwd")).unwrap_err();
        assert!(err.contains("BARE FILENAME"), "a path is refused here too: {err}");

        });
        // Fail closed: no scratch dir ⇒ the flag is refused rather than resolving against the cwd.
        bsc_cli_util::with_scratch(None, || {
            assert!(read_set_items("kit", Some("kit.json")).is_err(), "unset scratch refuses --file");
        });

        let _ = std::fs::remove_dir_all(&base);
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
                "list", "shapes", "get", "log", "set", "remove", "suppress", "unsuppress", "export", "import",
                "rename", "merge", "kit", "eslint-preset", "usage",
                "backing", "doctor", "dupes", "similar", "used-by", "define-animation", "list-animations", "remove-animation",
                "set-src", "patch", "refolder", "preview-props", "preview-errors", "preview-error"
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
        // #3382: the read-only scope is THREAD-LOCAL — no process env, so this refusal
        // test cannot leak into any test running beside it.
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
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
        });
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
    fn data_shapes_vocabulary_is_exactly_the_seven_canonical_shapes() {
        let names: Vec<&str> = DATA_SHAPES.iter().map(|(s, _)| *s).collect();
        assert_eq!(names, vec!["list", "linked-list", "tree", "graph", "table", "key-value", "series"]);
        for (s, d) in DATA_SHAPES {
            assert!(!d.is_empty(), "{s} carries a description");
            assert!(require_shape(s).is_ok());
        }
        // An off-vocabulary token errors, teaching the whole set.
        let err = require_shape("blob").unwrap_err();
        assert!(err.contains("unknown shape 'blob'"));
        for s in ["list", "linked-list", "tree", "graph", "table", "key-value", "series"] {
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
        assert!(err.contains("unknown shape 'blob'") && err.contains("key-value") && err.contains("series"));
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
        assert!(d.contains("key-value") && d.contains("series") && d.contains("ideal"), "shapes detail teaches the vocabulary");
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
        // fires because $BSC_UI_ACTIVITY_LOG is wired. This is the VICTIM side of the #3382 race — it
        // used to `remove_var($BSC_SCOPES)` to protect its own mutations, which is precisely what broke
        // the refusal tests running beside it. Declaring the unrestricted scope THREAD-LOCALLY says the
        // same thing without touching state anyone else can see.
        bsc_cli_util::with_scopes(None, || {
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
        });
    }

    #[test]
    fn get_and_preview_props_emit_a_ui_focus_not_a_touch() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        bsc_cli_util::with_scopes(None, || {
            let act = std::env::temp_dir().join(format!("bsc-component-uifocus-{}.log", std::process::id()));
            let _ = std::fs::remove_file(&act);
            std::env::set_var("BSC_UI_ACTIVITY_LOG", &act);
            std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");

            let dir = tmp_store_dir("focus-comp");
            bsc_json_store::Store::new(dir.clone(), "component")
                .set("button", r#"{"id":"button","name":"Button"}"#)
                .unwrap();

            // #3545: a READ (get / preview-props) focuses the component with `ui-focus`, never `ui-touch`.
            run(vec!["get".into(), "button".into(), "--dir".into(), dir.clone()], "bsc ui").unwrap();
            run(vec!["preview-props".into(), "button".into(), "--dir".into(), dir], "bsc ui").unwrap();

            // Presence, not absence: `$BSC_UI_ACTIVITY_LOG` is a process-global, so a CONCURRENT test's
            // own `set` emit can land in this file too (#3382). `>= 2` proves BOTH reads emitted a
            // ui-focus for `button`; that a ui-focus is NOT a ui-touch is pinned by the bsc-util test.
            let text = std::fs::read_to_string(&act).unwrap();
            assert!(
                text.matches("\tui-focus\tcomponent\tbutton").count() >= 2,
                "get + preview-props each emit a ui-focus for the component they read: {text:?}",
            );

            std::env::remove_var("BSC_UI_ACTIVITY_LOG");
            std::env::remove_var("BSC_AUDIT_PANE");
            let _ = std::fs::remove_file(&act);
        });
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
    fn doctor_fix_merges_byte_identical_dups_and_repoints_composers() {
        let dir = tmp_store_dir("doctor-merge");
        let store = bsc_json_store::Store::new(dir, "component");
        let src = "export function Button(){ return <button/>; }";
        // The canonical (most-used) + a byte-identical dup + a page that composes the DUP.
        store.set("btn", &serde_json::json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 9, "composes": [], "srcText": src, "source": src }).to_string()).unwrap();
        store.set("btn2", &serde_json::json!({ "id": "btn2", "name": "Btn2", "kitId": "k", "role": "primitive", "used": 1, "composes": [], "srcText": src, "source": src }).to_string()).unwrap();
        store.set("page", &serde_json::json!({ "id": "page", "name": "Page", "kitId": "k", "role": "page", "used": 2, "composes": ["Btn2"], "srcText": "p", "source": "export const C=()=>null;" }).to_string()).unwrap();

        let comps: Vec<serde_json::Value> = store.list().iter().filter_map(|j| serde_json::from_str(j).ok()).collect();

        // Dry run touches nothing.
        doctor_fix(&store, &comps, false).unwrap();
        assert!(store.get("btn2").unwrap().is_some(), "a dry run removes nothing");

        // Apply: the byte-identical dup is merged away; the canonical survives; the composer repoints.
        doctor_fix(&store, &comps, true).unwrap();
        assert!(store.get("btn2").unwrap().is_none(), "the byte-identical dup is merged away");
        assert!(store.get("btn").unwrap().is_some(), "the most-used canonical survives");
        let page: serde_json::Value = serde_json::from_str(&store.get("page").unwrap().unwrap()).unwrap();
        assert_eq!(page["composes"], serde_json::json!(["Button"]), "the composer repointed Btn2 → Button");
    }

    /// #3087 end-to-end: `--fix --yes` APPLIED against a store shaped like the live one must leave the
    /// pages tier and the packaged viz seeds standing, while still pruning a genuine user orphan.
    #[test]
    fn doctor_fix_apply_never_removes_a_page_or_a_builtin_seed() {
        let dir = tmp_store_dir("doctor-guards");
        let store = bsc_json_store::Store::new(dir, "component");
        let module = "export const C=()=>null;";
        let set = |id: &str, rec: serde_json::Value| store.set(id, &rec.to_string()).unwrap();
        // A used component so the usage index is POPULATED — guards 1+2 must stand on their own.
        set("btn", serde_json::json!({ "id": "btn", "name": "Button", "kitId": "k", "role": "primitive", "used": 7, "composes": [], "srcText": "b", "source": module }));
        // A page: a root by definition, composing its section component → "dangling-branch".
        set("invoicespage", serde_json::json!({ "id": "invoicespage", "name": "InvoicesPage", "kitId": "k", "role": "page", "used": 0, "composes": ["DataTable"], "srcText": "p", "source": module }));
        set("table", serde_json::json!({ "id": "table", "name": "DataTable", "kitId": "k", "role": "composite", "used": 0, "composes": [], "srcText": "t", "source": module }));
        // A packaged viz seed: isolated ON PURPOSE (#3194/#3242) → "orphan".
        set("algocells", serde_json::json!({ "id": "algocells", "name": "AlgoCells", "kitId": "k", "role": "primitive", "used": 0, "builtin": true, "composes": [], "srcText": "a", "source": module }));
        // A genuine user orphan — the case `--fix` exists for.
        set("ghost", serde_json::json!({ "id": "ghost", "name": "Ghost", "kitId": "k", "role": "primitive", "used": 0, "composes": [], "srcText": "g", "source": module }));

        let comps: Vec<serde_json::Value> = store.list().iter().filter_map(|j| serde_json::from_str(j).ok()).collect();
        doctor_fix(&store, &comps, true).unwrap();

        assert!(store.get("invoicespage").unwrap().is_some(), "a page is a root by definition — never pruned");
        assert!(store.get("algocells").unwrap().is_some(), "a packaged builtin seed is never pruned");
        assert!(store.get("ghost").unwrap().is_none(), "a genuine user orphan still prunes");
    }

    /// #3087 guard 3: a store with NO usage signal at all (nothing carries `used > 0` — the shape of a
    /// real install, since nothing increments the reuse count) prunes NOTHING.
    #[test]
    fn doctor_fix_apply_prunes_nothing_while_the_usage_index_is_unpopulated() {
        let dir = tmp_store_dir("doctor-usage-unknown");
        let store = bsc_json_store::Store::new(dir, "component");
        let module = "export const C=()=>null;";
        store.set("ghost", &serde_json::json!({ "id": "ghost", "name": "Ghost", "kitId": "k", "role": "primitive", "used": 0, "composes": [], "srcText": "g", "source": module }).to_string()).unwrap();

        let comps: Vec<serde_json::Value> = store.list().iter().filter_map(|j| serde_json::from_str(j).ok()).collect();
        // The orphan IS reported by the read-only analyzer …
        assert!(crate::graph_health::analyze(&comps).iter().any(|f| f.category == "orphan"));
        // … but `--fix --yes` leaves it alone: `used = 0` store-wide means UNKNOWN, not unused.
        doctor_fix(&store, &comps, true).unwrap();
        assert!(store.get("ghost").unwrap().is_some(), "no usage signal ⇒ no automatic removal");
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
        // #3382: the read-only scope is THREAD-LOCAL — no process env, so this refusal
        // test cannot leak into any test running beside it.
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
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
        });
    }

    // ── granular writes (#3162) ──────────────────────────────────────────────────────────────────

    #[test]
    fn normalize_pointer_adds_an_optional_leading_slash() {
        assert_eq!(normalize_pointer("/name").unwrap(), "/name");
        assert_eq!(normalize_pointer("name").unwrap(), "/name");
        assert_eq!(normalize_pointer("props/0/req").unwrap(), "/props/0/req");
        // The empty string stays empty (the whole-document pointer).
        assert_eq!(normalize_pointer("").unwrap(), "");
    }

    // #3383: git-bash rewrites any arg starting with `/` to the git install root, so the DOCUMENTED
    // `--field /name` reached the process as `C:/Program Files/Git/name` and failed as a missing field.
    // Every studio session runs in git-bash, so this hit every pointer they passed the documented way.
    #[test]
    fn normalize_pointer_rejects_an_msys_mangled_pointer_and_names_the_fix() {
        for mangled in [
            "C:/Program Files/Git/name",
            "C:/Program Files/Git/animations/1",
            r"D:\msys64\name",
        ] {
            let err = normalize_pointer(mangled).expect_err("a drive-letter prefix is never a pointer");
            assert!(err.contains("git-bash path conversion"), "explains the cause: {err}");
            // Names the SLASH-FREE form to use, not just the failure.
            assert!(err.contains("WITHOUT the leading slash"), "names the fix: {err}");
            // It must NOT invent a field name — the intended pointer is unrecoverable here, and a
            // guessed one would steer a wrong WRITE on `patch`.
            assert!(!err.contains("use `"), "never guesses the field: {err}");
            // ...and steers off the workaround a restricted session cannot run.
            assert!(err.contains("MSYS_NO_PATHCONV"), "warns off the env prefix: {err}");
        }
        assert!(normalize_pointer("C:/Program Files/Git/name").unwrap_err().contains("`name`"));
    }

    // A pointer that merely CONTAINS a colon is untouched — only a leading `X:/` or `X:\` is MSYS damage.
    #[test]
    fn normalize_pointer_leaves_a_legitimate_pointer_with_a_colon_alone() {
        assert_eq!(normalize_pointer("props/a:b").unwrap(), "/props/a:b");
        assert_eq!(normalize_pointer("/props/a:b").unwrap(), "/props/a:b");
    }

    #[test]
    fn set_at_pointer_sets_replaces_appends_and_errors_on_a_missing_parent() {
        use serde_json::json;
        let mut v = json!({ "name": "Old", "props": [{ "name": "a", "req": false }] });
        // Replace an existing object key + a nested array-element field.
        set_at_pointer(&mut v, "/name", json!("New")).unwrap();
        assert_eq!(v["name"], "New");
        set_at_pointer(&mut v, "/props/0/req", json!(true)).unwrap();
        assert_eq!(v["props"][0]["req"], true);
        // Insert a NEW object key (the field didn't exist yet).
        set_at_pointer(&mut v, "/group", json!("forms")).unwrap();
        assert_eq!(v["group"], "forms");
        // Append to an array by index == len, and via the `-` push token.
        set_at_pointer(&mut v, "/props/1", json!({ "name": "b" })).unwrap();
        set_at_pointer(&mut v, "/props/-", json!({ "name": "c" })).unwrap();
        assert_eq!(v["props"][1]["name"], "b");
        assert_eq!(v["props"][2]["name"], "c");
        // RFC-6901 escapes: ~1 → / and ~0 → ~.
        set_at_pointer(&mut v, "/a~1b", json!(1)).unwrap();
        assert_eq!(v["a/b"], 1);
        // Errors: a missing intermediate parent, an out-of-range index (no holes), the whole-doc
        // pointer (a patch is a FIELD write), and descending into a non-container.
        assert!(set_at_pointer(&mut v, "/missing/deep", json!(1)).is_err());
        assert!(set_at_pointer(&mut v, "/props/9", json!(1)).is_err());
        assert!(set_at_pointer(&mut v, "", json!(1)).is_err());
        assert!(set_at_pointer(&mut v, "/name/x", json!(1)).is_err());
    }

    #[test]
    fn set_src_replaces_only_srctext_and_gates_a_broken_module() {
        let dir = tmp_store_dir("set-src");
        let store = bsc_json_store::Store::new(dir, "component");
        store
            .set("btn", r#"{"id":"btn","name":"Button","kitId":"react-ui","role":"primitive","srcText":"old"}"#)
            .unwrap();

        // Replaces ONLY srcText — every other field is untouched.
        let good = "export function Button(){ return <button/>; }";
        replace_src(&store, "btn", good).unwrap();
        let rec: serde_json::Value = serde_json::from_str(&store.get("btn").unwrap().unwrap()).unwrap();
        assert_eq!(rec["srcText"], good);
        assert_eq!(rec["name"], "Button");
        assert_eq!(rec["kitId"], "react-ui");
        assert_eq!(rec["role"], "primitive");
        assert_eq!(rec["id"], "btn");

        // A corrupt module srcText is rejected by the #2928 gate BEFORE anything is written — the stored
        // record is left exactly as it was.
        let err = replace_src(&store, "btn", "export const s = [1,2].join(\"\n\");").unwrap_err();
        assert!(err.contains("unterminated string literal"), "{err}");
        let rec2: serde_json::Value = serde_json::from_str(&store.get("btn").unwrap().unwrap()).unwrap();
        assert_eq!(rec2["srcText"], good, "the rejected write left srcText untouched");

        // An absent component errors, naming it.
        assert!(replace_src(&store, "ghost", "x").unwrap_err().contains("ghost"));
    }

    #[test]
    fn patch_sets_one_field_by_pointer_and_gates_a_srctext_patch() {
        use serde_json::json;
        let dir = tmp_store_dir("patch");
        let store = bsc_json_store::Store::new(dir, "component");
        store
            .set("card", r#"{"id":"card","name":"Card","kitId":"react-ui","props":[{"name":"a","req":false}]}"#)
            .unwrap();

        // Patch a top-level field and a nested array-element field; every other field stays put.
        apply_patch(&store, "card", "/name", json!("Panel")).unwrap();
        apply_patch(&store, "card", "/props/0/req", json!(true)).unwrap();
        let rec: serde_json::Value = serde_json::from_str(&store.get("card").unwrap().unwrap()).unwrap();
        assert_eq!(rec["name"], "Panel");
        assert_eq!(rec["props"][0]["req"], true);
        assert_eq!(rec["kitId"], "react-ui");
        assert_eq!(rec["id"], "card");

        // A `patch /srcText` still passes through the #2928 gate — a broken module is refused and NOT
        // stored (the granular write can't bypass the syntax check).
        let err = apply_patch(&store, "card", "/srcText", json!("export const s = [1,2].join(\"\n\");")).unwrap_err();
        assert!(err.contains("unterminated string literal"), "{err}");
        let rec2: serde_json::Value = serde_json::from_str(&store.get("card").unwrap().unwrap()).unwrap();
        assert!(rec2.get("srcText").is_none(), "the rejected srcText patch was never stored");

        // A missing parent and an absent component both error.
        assert!(apply_patch(&store, "card", "/deep/x", json!(1)).is_err());
        assert!(apply_patch(&store, "ghost", "/name", json!("x")).unwrap_err().contains("ghost"));
    }

    #[test]
    fn field_output_raw_unwraps_strings_and_jsons_everything_else() {
        use serde_json::json;
        // --raw: a string prints unquoted (clean shell capture); a non-string prints as compact JSON.
        assert_eq!(field_output(&json!("Button"), true, false).unwrap(), "Button");
        assert_eq!(field_output(&json!(true), true, false).unwrap(), "true");
        assert_eq!(field_output(&json!(42), true, false).unwrap(), "42");
        assert_eq!(field_output(&json!({ "a": 1 }), true, false).unwrap(), "{\"a\":1}");
        // Without --raw a string keeps its JSON quotes; --pretty indents a container.
        assert_eq!(field_output(&json!("Button"), false, false).unwrap(), "\"Button\"");
        assert!(field_output(&json!({ "a": 1 }), false, true).unwrap().contains('\n'));
    }

    #[test]
    fn get_field_runs_through_the_cli_and_errors_on_a_missing_field() {
        let dir = tmp_store_dir("get-field");
        let store = bsc_json_store::Store::new(dir.clone(), "component");
        store.set("card", r#"{"id":"card","name":"Card","props":[{"name":"a"}]}"#).unwrap();
        // Reads run Ok end-to-end — with and without the leading `/`, raw + json, and a nested pointer.
        for a in [
            vec!["get", "card", "--field", "/name", "--raw", "--dir", &dir],
            vec!["get", "card", "--field", "name", "--dir", &dir],
            vec!["get", "card", "--field", "/props/0/name", "--dir", &dir],
        ] {
            assert!(run(a.iter().map(|s| s.to_string()).collect(), "bsc ui").is_ok(), "read runs: {a:?}");
        }
        // A missing field errors, naming both the field and the component.
        let err = run(
            vec!["get".into(), "card".into(), "--field".into(), "/nope".into(), "--dir".into(), dir.clone()],
            "bsc ui",
        )
        .unwrap_err();
        assert!(err.contains("nope") && err.contains("card"), "{err}");
        // A plain `get` (no --field) is NOT intercepted — it still delegates to the store CLI.
        assert!(run(vec!["get".into(), "card".into(), "--dir".into(), dir], "bsc ui").is_ok());
    }

    #[test]
    fn get_out_spills_the_value_into_the_scratch_dir_untruncated() {
        use serde_json::json;
        // #3713: the motivating case — a srcText far larger than the ~30KB stdout truncation ceiling.
        let dir = tmp_store_dir("get-out");
        let store = bsc_json_store::Store::new(dir.clone(), "component");
        let big = format!("export function FleetPage(){{ return <div>{}</div>; }}", "x".repeat(40_000));
        store.set("fleetpage", &json!({ "id":"fleetpage", "name":"FleetPage", "srcText": big }).to_string()).unwrap();

        let scratch = std::env::temp_dir().join(format!("bsc-comp-getout-scratch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let scratch_str = scratch.to_string_lossy().into_owned();

        bsc_cli_util::with_scratch(Some(&scratch_str), || {
            // The exact #20 command: `get <id> --field srcText --raw --out <name>` — writes the FULL
            // srcText to a confinement-allowed scratch file instead of truncated stdout.
            run(vec!["get".into(), "fleetpage".into(), "--field".into(), "srcText".into(), "--raw".into(),
                     "--out".into(), "src.tsx".into(), "--dir".into(), dir.clone()], "bsc ui").unwrap();
            let got = std::fs::read_to_string(scratch.join("src.tsx")).unwrap();
            assert_eq!(got.trim_end_matches('\n'), big, "the full srcText landed untruncated");

            // Whole-record `--out` (no --field) writes the record JSON.
            run(vec!["get".into(), "fleetpage".into(), "--out".into(), "rec.json".into(), "--dir".into(), dir.clone()],
                "bsc ui").unwrap();
            assert!(std::fs::read_to_string(scratch.join("rec.json")).unwrap().contains("\"id\":\"fleetpage\""),
                "the whole record landed too");

            // The traversal defence refuses a non-bare --out name.
            let err = run(vec!["get".into(), "fleetpage".into(), "--field".into(), "srcText".into(),
                              "--out".into(), "../escape".into(), "--dir".into(), dir.clone()], "bsc ui").unwrap_err();
            assert!(err.contains("BARE FILENAME"), "a path traversal is refused: {err}");
        });
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn granular_writes_refuse_under_a_read_ui_scope_before_stdin_or_the_store() {
        // #3382: the read-only scope is THREAD-LOCAL — no process env, so this refusal
        // test cannot leak into any test running beside it.
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
            // set-src is a MUTATION: it refuses at the write-scope gate BEFORE reading stdin (so no --dir /
            // stdin is passed — the gate fires first and the test can never block on stdin).
            let err = run(vec!["set-src".into(), "x".into()], "bsc ui").unwrap_err();
            assert!(err.contains("'ui'") && err.contains("read-only"), "set-src read-scope refusal: {err}");
            // patch refuses the same way, before the store is touched.
            let err = run(vec!["patch".into(), "x".into(), "/name".into(), "Button".into()], "bsc ui").unwrap_err();
            assert!(err.contains("'ui'") && err.contains("read-only"), "patch read-scope refusal: {err}");
            // `get --field` is a READ — reachable under the read scope (against a scratch --dir).
            let dir = tmp_store_dir("granular-read-scope");
            bsc_json_store::Store::new(dir.clone(), "component")
                .set("card", r#"{"id":"card","name":"Card"}"#)
                .unwrap();
            assert!(run(
                vec!["get".into(), "card".into(), "--field".into(), "/name".into(), "--raw".into(), "--dir".into(), dir],
                "bsc ui"
            )
            .is_ok());
            // Help stays reachable read-scoped for both writers.
            assert!(run(vec!["set-src".into(), "help".into()], "bsc ui").is_ok());
            assert!(run(vec!["patch".into(), "help".into()], "bsc ui").is_ok());
        });
    }

    #[test]
    fn granular_write_verbs_appear_in_help_with_their_detail() {
        let ov = bsc_cli_util::help_overview("bsc ui", TAGLINE, COMPONENT_COMMANDS);
        for c in ["set-src", "patch"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let s = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "set-src");
        assert!(s.contains("stdin") && s.contains("syntax gate"), "set-src detail: {s}");
        let p = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "patch");
        assert!(p.contains("JSON pointer") && p.contains("parsed as JSON"), "patch detail: {p}");
        // The `get` detail now documents the --field/--raw form.
        let g = bsc_cli_util::help_for("bsc ui", TAGLINE, COMPONENT_COMMANDS, "get");
        assert!(g.contains("--field") && g.contains("--raw"), "get detail documents --field/--raw: {g}");
    }

    // ── record history / attribution / optimistic concurrency (#3164) ────────────────────────────

    /// A scratch COMPONENT store over a fresh temp dir, for the stamping tests.
    fn tmp_component_store(tag: &str) -> bsc_json_store::Store {
        bsc_json_store::Store::new(tmp_store_dir(tag), "component")
    }

    /// Parse a stored record's verbatim JSON back to a `Value` (the read-back the assertions use).
    fn stored(store: &bsc_json_store::Store, id: &str) -> serde_json::Value {
        serde_json::from_str(&store.get(id).unwrap().unwrap()).unwrap()
    }

    #[test]
    fn set_stamped_bumps_rev_and_stamps_attribution_on_each_write() {
        let store = tmp_component_store("stamp-bump");
        let rec = serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui" });

        // First write of a brand-new record → rev 1, updatedBy = the writer, updatedAt an ISO stamp.
        let ids = set_stamped(&store, std::slice::from_ref(&rec), None, "alice", "component", None).unwrap();
        assert_eq!(ids, vec!["button".to_string()]);
        let s = stored(&store, "button");
        assert_eq!(s["rev"], serde_json::json!(1), "a fresh record's first write is rev 1");
        assert_eq!(s["updatedBy"], "alice");
        assert!(s["updatedAt"].as_str().is_some_and(|t| t.ends_with('Z')), "updatedAt is an ISO stamp");
        // Stamping never disturbs the domain fields.
        assert_eq!(s["name"], "Button");
        assert_eq!(s["kitId"], "react-ui");

        // A second write of the same id bumps from the STORED rev (1 → 2), even though the payload carries none.
        set_stamped(&store, std::slice::from_ref(&rec), None, "bob", "component", None).unwrap();
        let s = stored(&store, "button");
        assert_eq!(s["rev"], serde_json::json!(2), "the second write bumps to rev 2");
        assert_eq!(s["updatedBy"], "bob", "attribution follows the latest writer");
    }

    #[test]
    fn set_stamped_if_version_rejects_a_stale_write_and_allows_a_current_one() {
        let store = tmp_component_store("stamp-ifver");
        let rec = serde_json::json!({ "id": "chip", "name": "Chip" });
        set_stamped(&store, std::slice::from_ref(&rec), None, "x", "component", None).unwrap(); // → rev 1

        // --if-version 0 is STALE (current rev is 1): rejected with a clear message, nothing overwritten.
        let err = set_stamped(&store, std::slice::from_ref(&rec), Some(0), "x", "component", None).unwrap_err();
        assert!(err.contains("version conflict") && err.contains("rev is 1"), "clear conflict message: {err}");
        assert_eq!(stored(&store, "chip")["rev"], serde_json::json!(1), "the stale write did NOT clobber");

        // --if-version 1 matches the current rev → the write lands and bumps to 2.
        set_stamped(&store, std::slice::from_ref(&rec), Some(1), "x", "component", None).unwrap();
        assert_eq!(stored(&store, "chip")["rev"], serde_json::json!(2));

        // --if-version guards a SINGLE record — a batch with a lone version number is a usage error.
        let batch = vec![serde_json::json!({ "id": "a" }), serde_json::json!({ "id": "b" })];
        let err = set_stamped(&store, &batch, Some(1), "x", "component", None).unwrap_err();
        assert!(err.contains("--if-version") && err.contains("single"), "batch + version rejected: {err}");
    }

    #[test]
    fn a_legacy_record_without_rev_reads_as_rev_zero_for_concurrency() {
        let store = tmp_component_store("stamp-legacy");
        // Pre-seed a legacy record straight into the store (no rev/updatedAt — the pre-#3164 shape).
        store.set("legacy", r#"{"id":"legacy","name":"Legacy"}"#).unwrap();
        assert_eq!(current_rev(&store, "legacy").unwrap(), 0, "no rev ⇒ reads as 0");
        assert_eq!(current_rev(&store, "absent").unwrap(), 0, "an absent record ⇒ reads as 0");

        // So --if-version 0 succeeds against it (backward-compatible), stamping it forward to rev 1.
        let rec = serde_json::json!({ "id": "legacy", "name": "Legacy v2" });
        set_stamped(&store, std::slice::from_ref(&rec), Some(0), "migrator", "component", None).unwrap();
        let s = stored(&store, "legacy");
        assert_eq!(s["rev"], serde_json::json!(1));
        assert_eq!(s["updatedBy"], "migrator");
        assert_eq!(s["name"], "Legacy v2", "the new content landed");
    }

    #[test]
    fn get_and_list_are_unaffected_by_the_stamp_fields() {
        let store = tmp_component_store("stamp-getlist");
        let dir = store.dir().to_string_lossy().into_owned();
        let rec = serde_json::json!({
            "id": "card", "name": "Card", "kitId": "react-ui", "role": "layout", "folder": "pages", "shapes": ["list"]
        });
        set_stamped(&store, std::slice::from_ref(&rec), None, "designer", "component", None).unwrap();

        // The lean projection is byte-for-byte the same — the stamp fields don't leak into it, the axes still project.
        let meta = bsc_json_store::cli::lean_meta(&store.get("card").unwrap().unwrap(), COMPONENT_SPEC.meta_fields);
        assert_eq!(
            meta,
            serde_json::json!({ "id": "card", "name": "Card", "kitId": "react-ui", "role": "layout", "folder": "pages", "shapes": ["list"] })
        );
        // get / list / list --full still run clean end-to-end over a stamped store.
        assert!(run(vec!["get".into(), "card".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["list".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["list".into(), "--full".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        // doctor still parses the stamped records (the extra fields don't perturb graph health).
        assert!(run(vec!["doctor".into(), "--dir".into(), dir], "bsc ui").is_ok());
    }

    #[test]
    fn graph_projection_carries_the_node_and_edge_fields_and_drops_the_payload() {
        // #4072 — the Design Studio hydrated its graph with `--full`: 1.72 MB over 321 components, of
        // which 77.6% is `srcText` that no node reads, and the page blocked up to 8s on it. The graph
        // projection must carry the node card + `composes` (edges) and NOTHING heavy.
        let store = tmp_component_store("graphproj");
        let dir = store.dir().to_string_lossy().into_owned();
        let rec = serde_json::json!({
            "id": "card", "name": "Card", "kitId": "react-ui", "role": "layout", "folder": "pages",
            "used": 12, "composes": ["Box", "Text"],
            // The weight the projection exists to leave behind:
            "srcText": "export function Card() { /* … a great many bytes … */ }",
            "tests": ["a", "b"], "history": [{ "rev": 1 }], "props": { "title": "string" },
        });
        set_stamped(&store, std::slice::from_ref(&rec), None, "designer", "component", None).unwrap();

        let g = bsc_json_store::cli::lean_meta(&store.get("card").unwrap().unwrap(), COMPONENT_SPEC.graph_fields);
        assert_eq!(
            g,
            serde_json::json!({
                "id": "card", "name": "Card", "kitId": "react-ui", "role": "layout",
                "folder": "pages", "used": 12, "composes": ["Box", "Text"]
            })
        );
        // The heavy fields are absent, not merely empty — that is the whole point.
        for heavy in ["srcText", "tests", "history", "props"] {
            assert!(g.get(heavy).is_none(), "{heavy} must not ride the graph projection");
        }
        // And it runs clean end-to-end.
        assert!(run(vec!["list".into(), "--graph".into(), "--dir".into(), dir], "bsc ui").is_ok());
    }

    #[test]
    fn graph_projection_defaults_a_missing_used_rather_than_dropping_the_key() {
        // Harvested records carry no `used` (274 of 321 locally). The key must still be present so the
        // client's `typeof c.used === "number" ? c.used : 0` sees a stable shape.
        let store = tmp_component_store("graphproj-nouse");
        let rec = serde_json::json!({ "id": "b", "name": "Btn", "kitId": "k", "role": "control" });
        set_stamped(&store, std::slice::from_ref(&rec), None, "designer", "component", None).unwrap();
        let g = bsc_json_store::cli::lean_meta(&store.get("b").unwrap().unwrap(), COMPONENT_SPEC.graph_fields);
        assert_eq!(g.get("used"), Some(&serde_json::json!("")));
        assert_eq!(g.get("composes"), Some(&serde_json::json!("")));
    }

    #[test]
    fn log_verb_prints_the_current_stamp_and_errors_on_an_absent_record() {
        let store = tmp_component_store("stamp-log");
        let dir = store.dir().to_string_lossy().into_owned();
        let rec = serde_json::json!({ "id": "hero", "name": "Hero" });
        set_stamped(&store, std::slice::from_ref(&rec), None, "ada", "component", None).unwrap();

        // `log <id>` reads Ok over the stamped record (compact + --pretty); `log` of an absent id errors.
        assert!(run(vec!["log".into(), "hero".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["log".into(), "hero".into(), "--pretty".into(), "--dir".into(), dir.clone()], "bsc ui").is_ok());
        assert!(run(vec!["log".into(), "ghost".into(), "--dir".into(), dir], "bsc ui").is_err());

        // The log VALUE surfaces the three provenance fields (record::log_value is the pure core).
        let logged = crate::record::log_value("hero", &stored(&store, "hero"));
        assert_eq!(logged["rev"], serde_json::json!(1));
        assert_eq!(logged["updatedBy"], "ada");
        assert!(logged["updatedAt"].as_str().is_some_and(|t| t.ends_with('Z')));
    }

    #[test]
    fn the_animation_write_path_also_stamps_the_record_rev() {
        // "Stamp at the write boundary so ALL writers get stamped" (#3164): an animation edit — not just
        // `set` — bumps the record's rev + attribution, because it funnels through `stamped_set`.
        let store = tmp_component_store("stamp-anim");
        store.set("card", r#"{"id":"card","name":"Card"}"#).unwrap(); // legacy seed (rev 0)
        upsert_animation(&store, "card", &valid_anim("fade-in")).unwrap();
        let s = stored(&store, "card");
        assert_eq!(s["rev"], serde_json::json!(1), "the first animation write stamps rev 1");
        assert!(s["updatedAt"].as_str().is_some_and(|t| t.ends_with('Z')));
        // A second animation edit bumps again — the animations array is preserved alongside the stamp.
        upsert_animation(&store, "card", &valid_anim("slide-up")).unwrap();
        let s = stored(&store, "card");
        assert_eq!(s["rev"], serde_json::json!(2), "a second animation write bumps to rev 2");
        assert_eq!(s["animations"].as_array().map(Vec::len), Some(2), "both animations survive the stamp");
    }

    #[test]
    fn set_stamped_accumulates_a_change_history_with_notes_and_diffs() {
        // #3568: every write through the stamp boundary appends a capped history entry that Claude can review.
        let store = tmp_component_store("history");
        let v1 = serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui" });
        set_stamped(&store, std::slice::from_ref(&v1), None, "designer", "component", Some("initial draft")).unwrap();
        // A second, real edit with a note — one field changes.
        let v2 = serde_json::json!({ "id": "button", "name": "Primary Button", "kitId": "react-ui" });
        set_stamped(&store, std::slice::from_ref(&v2), None, "alice", "component", Some("rename")).unwrap();

        let s = stored(&store, "button");
        let hist = s["history"].as_array().expect("history is recorded");
        assert_eq!(hist.len(), 2, "one entry per write, newest-last");
        assert_eq!(hist[0]["rev"], serde_json::json!(1));
        assert_eq!(hist[0]["by"], "designer");
        assert_eq!(hist[0]["note"], "initial draft");
        assert_eq!(hist[0]["changed"], serde_json::json!(["created"]), "the first write is 'created'");
        assert_eq!(hist[1]["rev"], serde_json::json!(2));
        assert_eq!(hist[1]["by"], "alice");
        assert_eq!(hist[1]["note"], "rename");
        assert_eq!(hist[1]["changed"], serde_json::json!(["name"]), "only name diffed on the second write");

        // The animation path (a different writer) also records history — the boundary catches every writer.
        upsert_animation(&store, "button", &valid_anim("fade-in")).unwrap();
        let hist = stored(&store, "button")["history"].as_array().unwrap().clone();
        assert_eq!(hist.len(), 3, "the animation edit is logged too");
        assert_eq!(hist[2]["changed"], serde_json::json!(["animations"]), "the animation write diffs `animations`");
    }

    #[test]
    fn set_command_argv_records_by_and_note_in_history_end_to_end() {
        // #3568: drive the REAL `run(["set", …])` dispatch (not just set_stamped) so the `--by` / `--note`
        // flag parsing → stored history entry is covered end-to-end. `--file` carries the payload (the one
        // allow-listable authoring channel), read from a scoped $BSC_SCRATCH.
        let store = tmp_component_store("history-argv");
        let dir = store.dir().to_string_lossy().into_owned();
        let base = std::env::temp_dir().join(format!("bsc-scratch-note-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let scratch = base.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        std::fs::write(scratch.join("c.json"), r#"{"id":"btn","name":"Button","kitId":"react-ui"}"#).unwrap();

        bsc_cli_util::with_scratch(scratch.to_str(), || {
            run(
                vec![
                    "set".into(), "--file".into(), "c.json".into(),
                    "--by".into(), "designer".into(), "--note".into(), "add error state".into(),
                    "--dir".into(), dir.clone(),
                ],
                "bsc ui",
            )
            .expect("set --by --note lands");
        });

        let entry = stored(&store, "btn")["history"].as_array().unwrap()[0].clone();
        assert_eq!(entry["by"], "designer", "--by flows to the history entry");
        assert_eq!(entry["note"], "add error state", "--note flows to the history entry");
        assert_eq!(entry["changed"], serde_json::json!(["created"]), "the first write is 'created'");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_set_verb_is_registered_gated_and_help_reachable() {
        // `log` + `set` are in the catalog; `log` is a READ (never gated), `set` is a MUTATION.
        let names: Vec<&str> = COMPONENT_COMMANDS.iter().map(|c| c.name).collect();
        assert!(names.contains(&"log") && names.contains(&"set"));
        let a = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_scoped_mutation(&a(&["set", "--if-version", "3"])), "set is a mutation even with flags");
        assert!(!is_scoped_mutation(&a(&["log", "button"])), "log is a read");

        // `set`/`kit set` refuse under a read `ui` scope BEFORE touching stdin or the store; help still prints.
        // #3382: the read-only scope is THREAD-LOCAL — no process env, so this refusal
        // test cannot leak into any test running beside it.
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
            let err = run(vec!["set".into(), "--by".into(), "x".into()], "bsc ui").unwrap_err();
            assert!(err.contains("'ui'") && err.contains("read-only"), "set refuses read-scoped: {err}");
            let err = run(vec!["kit".into(), "set".into()], "bsc ui").unwrap_err();
            assert!(err.contains("read-only"), "kit set refuses read-scoped: {err}");
            assert!(run(vec!["set".into(), "help".into()], "bsc ui").is_ok(), "set help stays reachable read-scoped");
            assert!(run(vec!["log".into(), "help".into()], "bsc ui").is_ok(), "log help stays reachable read-scoped");
        });
    }

    #[test]
    fn used_by_index_is_the_kit_scoped_composes_inverse() {
        // #3584: the graph-usage signal. Button is composed by Card + Panel (2) in react-ui; a SAME-NAMED
        // Button in another kit is counted SEPARATELY (composes resolves by name WITHIN a kit).
        let comps = vec![
            serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui", "composes": [] }),
            serde_json::json!({ "id": "card", "name": "Card", "kitId": "react-ui", "composes": ["Button", "Icon"] }),
            serde_json::json!({ "id": "panel", "name": "Panel", "kitId": "react-ui", "composes": ["Button"] }),
            serde_json::json!({ "id": "muibutton", "name": "Button", "kitId": "mui", "composes": [] }),
            serde_json::json!({ "id": "toolbar", "name": "Toolbar", "kitId": "mui", "composes": ["Button"] }),
        ];
        let idx = used_by_index(&comps);
        assert_eq!(
            idx.get(&("react-ui".into(), "Button".into())),
            Some(&vec!["Card".to_string(), "Panel".to_string()]),
            "react-ui Button: composed by Card + Panel, sorted+deduped",
        );
        assert_eq!(idx.get(&("mui".into(), "Button".into())).map(Vec::len), Some(1), "the other kit's Button is separate");
        assert!(!idx.contains_key(&("react-ui".into(), "Card".into())), "nothing composes Card ⇒ absent (an orphan/root)");
        assert_eq!(idx.get(&("react-ui".into(), "Icon".into())).map(Vec::len), Some(1), "a composed NAME appears even with no own record");
    }

    #[test]
    fn used_by_command_reads_single_and_all_and_is_never_gated() {
        let store = tmp_component_store("usedby");
        let dir = store.dir().to_string_lossy().into_owned();
        for rec in [
            serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui", "role": "primitive", "composes": [] }),
            serde_json::json!({ "id": "card", "name": "Card", "kitId": "react-ui", "role": "composite", "composes": ["Button"] }),
        ] {
            store.set(rec["id"].as_str().unwrap(), &rec.to_string()).unwrap();
        }
        let d = |extra: &[&str]| {
            extra.iter().map(|s| s.to_string()).chain(["--dir".to_string(), dir.clone()]).collect::<Vec<_>>()
        };
        assert!(run(d(&["used-by", "button", "--json"]), "bsc ui").is_ok(), "single form");
        assert!(run(d(&["used-by", "--all"]), "bsc ui").is_ok(), "--all ranking");
        assert!(run(d(&["used-by", "--all", "--kit", "react-ui", "--json"]), "bsc ui").is_ok(), "--all --kit --json");
        assert!(run(vec!["used-by".into(), "help".into()], "bsc ui").is_ok(), "help reachable");
        let err = run(d(&["used-by", "ghost"]), "bsc ui").unwrap_err();
        assert!(err.contains("no component with id 'ghost'"), "{err}");

        // A READ — in the catalog, never a scoped mutation, and runs under a read-only ui scope.
        assert!(COMPONENT_COMMANDS.iter().any(|c| c.name == "used-by"));
        assert!(!is_scoped_mutation(&["used-by".to_string(), "button".to_string()]), "used-by is a read");
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
            assert!(run(d(&["used-by", "button"]), "bsc ui").is_ok(), "used-by works read-scoped");
        });
    }

    #[test]
    fn similar_folds_in_each_candidate_usage() {
        // #3584: `similar` still ranks by name+contract, but each row now carries `usedBy` so a combine
        // proposal shows which side is load-bearing. Card2 duplicates Card's contract; Card is composed by
        // Page (used-by 1), Card2 by nothing (0) — so the optimizer folds Card2 → Card.
        let comps = vec![
            serde_json::json!({ "id": "card", "name": "Card", "kitId": "k", "role": "composite", "props": [{ "name": "title", "type": "string" }], "variants": [], "composes": [], "srcText": "<div/>" }),
            serde_json::json!({ "id": "card2", "name": "CardView", "kitId": "k", "role": "composite", "props": [{ "name": "title", "type": "string" }], "variants": [], "composes": [], "srcText": "<div/>" }),
            serde_json::json!({ "id": "page", "name": "Page", "kitId": "k", "role": "page", "composes": ["Card"] }),
        ];
        let idx = used_by_index(&comps);
        // The fold is a lookup on this index (exercised live by `cmd_similar`): Card is load-bearing, CardView isn't.
        assert_eq!(idx.get(&("k".into(), "Card".into())).map(Vec::len), Some(1));
        assert!(!idx.contains_key(&("k".into(), "CardView".into())));
        // And the command runs end-to-end.
        let store = tmp_component_store("similar-usage");
        let dir = store.dir().to_string_lossy().into_owned();
        for c in &comps { store.set(c["id"].as_str().unwrap(), &c.to_string()).unwrap(); }
        assert!(run(vec!["similar".into(), "card2".into(), "--json".into(), "--dir".into(), dir], "bsc ui").is_ok());
    }

    #[test]
    fn rename_ident_replaces_whole_identifiers_only() {
        // #3576: the boundary rule — `Button` → `PrimaryButton` rewrites the declaration and the JSX tag,
        // but NEVER the substring inside `IconButton` / `ButtonGroup` / `notButton`.
        assert_eq!(rename_ident("export function Button() {}", "Button", "PrimaryButton"), "export function PrimaryButton() {}");
        assert_eq!(rename_ident("<Button label=\"x\" />", "Button", "PrimaryButton"), "<PrimaryButton label=\"x\" />");
        assert_eq!(
            rename_ident("import { IconButton } from x; <ButtonGroup/> notButton", "Button", "PrimaryButton"),
            "import { IconButton } from x; <ButtonGroup/> notButton",
            "substrings of a larger identifier are untouched",
        );
        assert_eq!(rename_ident("Button, Button.Item", "Button", "B2"), "B2, B2.Item", "punctuation is a boundary");
        assert_eq!(rename_ident("nothing here", "Button", "B2"), "nothing here");
    }

    #[test]
    fn is_component_name_ident_requires_pascal_case() {
        for ok in ["Button", "Button2", "A", "PrimaryButton"] {
            assert!(is_component_name_ident(ok), "{ok} is valid");
        }
        for bad in ["button", "", "My-Button", "2Button", "Foo Bar", "with_underscore"] {
            assert!(!is_component_name_ident(bad), "{bad:?} is invalid");
        }
    }

    #[test]
    fn rename_moves_the_name_sweeps_references_and_freezes_the_id() {
        let store = tmp_component_store("rename");
        let dir = store.dir().to_string_lossy().into_owned();
        // Button (target) · Card (composes Button + a rule using Button) · a SAME-NAMED Button in another kit.
        for rec in [
            serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui", "role": "primitive",
                "srcText": "export function Button() { return <button/>; }" }),
            serde_json::json!({ "id": "card", "name": "Card", "kitId": "react-ui", "role": "composite",
                "composes": ["Button", "Icon"],
                "rules": [{ "id": "r1", "kind": "forbid-element", "target": "button", "use": "Button" }] }),
            serde_json::json!({ "id": "muibutton", "name": "Button", "kitId": "mui", "role": "primitive" }),
        ] {
            store.set(rec["id"].as_str().unwrap(), &rec.to_string()).unwrap();
        }

        run(vec!["rename".into(), "button".into(), "PrimaryButton".into(), "--by".into(), "designer".into(), "--dir".into(), dir.clone()], "bsc ui")
            .expect("rename lands");

        // id is FROZEN; name + srcText identifier moved; history stamped with the default note.
        let b = stored(&store, "button");
        assert_eq!(b["id"], "button", "the store key never moves");
        assert_eq!(b["name"], "PrimaryButton");
        assert!(b["srcText"].as_str().unwrap().contains("export function PrimaryButton"), "srcText: {}", b["srcText"]);
        assert!(b["srcText"].as_str().unwrap().contains("<button/>"), "the intrinsic <button/> is NOT touched");
        assert_eq!(b["history"].as_array().unwrap().last().unwrap()["note"], "renamed Button → PrimaryButton");

        // Card's NAME-keyed references rewired; the intrinsic `target` + the unrelated `Icon` are not.
        let c = stored(&store, "card");
        assert_eq!(c["composes"], serde_json::json!(["PrimaryButton", "Icon"]));
        assert_eq!(c["rules"][0]["use"], "PrimaryButton");
        assert_eq!(c["rules"][0]["target"], "button", "the raw intrinsic is left alone");

        // A same-named component in ANOTHER kit is never touched (kits never cross).
        let o = stored(&store, "muibutton");
        assert_eq!(o["name"], "Button");
        assert!(o.get("history").is_none(), "the other kit's Button was not even written");
    }

    #[test]
    fn rename_refuses_bad_name_collision_and_absent_without_mutating() {
        let store = tmp_component_store("rename-refuse");
        let dir = store.dir().to_string_lossy().into_owned();
        store.set("button", &serde_json::json!({ "id": "button", "name": "Button", "kitId": "react-ui" }).to_string()).unwrap();
        store.set("chip", &serde_json::json!({ "id": "chip", "name": "Chip", "kitId": "react-ui" }).to_string()).unwrap();

        let refuse = |args: &[&str], needle: &str| {
            let v: Vec<String> = args.iter().map(|s| s.to_string()).chain(["--dir".to_string(), dir.clone()]).collect();
            let err = run(v, "bsc ui").unwrap_err();
            assert!(err.contains(needle), "expected '{needle}' in: {err}");
        };
        refuse(&["rename", "button", "lowercase"], "PascalCase");
        refuse(&["rename", "button", "Button"], "already named");
        refuse(&["rename", "button", "Chip"], "already has a component named");
        refuse(&["rename", "ghost", "NewName"], "no component 'ghost'");

        // Not one refusal mutated the record.
        assert_eq!(stored(&store, "button")["name"], "Button");
        assert!(stored(&store, "button").get("history").is_none(), "no write happened");
    }

    #[test]
    fn rename_is_registered_gated_and_help_reachable() {
        assert!(COMPONENT_COMMANDS.iter().any(|c| c.name == "rename"));
        let a = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_scoped_mutation(&a(&["rename", "button", "New"])), "rename is a mutation");
        assert!(!is_scoped_mutation(&a(&["rename", "help"])), "rename help is not a mutation");
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
            let err = run(vec!["rename".into(), "button".into(), "New".into()], "bsc ui").unwrap_err();
            assert!(err.contains("read-only"), "rename refuses read-scoped: {err}");
            assert!(run(vec!["rename".into(), "help".into()], "bsc ui").is_ok(), "rename help stays reachable read-scoped");
        });
    }

    #[test]
    fn merge_folds_from_into_survivor_repoints_dedups_and_removes() {
        let store = tmp_component_store("merge");
        let dir = store.dir().to_string_lossy().into_owned();
        // Card (survivor) · CardView (dup) · Page composes BOTH + a rule using CardView · Card composes
        // CardView (the self-ref the fold creates) · a same-named CardView in ANOTHER kit.
        for rec in [
            serde_json::json!({ "id": "card", "name": "Card", "kitId": "k", "role": "composite", "composes": ["CardView"] }),
            serde_json::json!({ "id": "cardview", "name": "CardView", "kitId": "k", "role": "composite", "composes": [] }),
            serde_json::json!({ "id": "page", "name": "Page", "kitId": "k", "role": "page",
                "composes": ["Card", "CardView", "Icon"],
                "rules": [{ "id": "r1", "kind": "forbid-element", "target": "div", "use": "CardView" }] }),
            serde_json::json!({ "id": "muicardview", "name": "CardView", "kitId": "mui", "role": "composite" }),
        ] {
            store.set(rec["id"].as_str().unwrap(), &rec.to_string()).unwrap();
        }

        run(vec!["merge".into(), "cardview".into(), "card".into(), "--by".into(), "curator".into(), "--dir".into(), dir.clone()], "bsc ui")
            .expect("merge lands");

        // `from` is GONE; `into` survives.
        assert!(store.get("cardview").unwrap().is_none(), "the merged-away component is removed");
        // Page: CardView→Card, DEDUPED (had both Card + CardView ⇒ Card once); Icon kept; rule repointed; history stamped.
        let p = stored(&store, "page");
        assert_eq!(p["composes"], serde_json::json!(["Card", "Icon"]), "deduped composes; Icon untouched");
        assert_eq!(p["rules"][0]["use"], "Card", "rules.use repointed");
        assert_eq!(p["history"].as_array().unwrap().last().unwrap()["note"], "merged CardView → Card");
        // Card composed CardView (== itself after the fold) ⇒ the self-reference is DROPPED.
        assert_eq!(stored(&store, "card")["composes"], serde_json::json!([]), "no component composes itself");
        // The other kit's CardView is never touched (kits never cross).
        assert_eq!(stored(&store, "muicardview")["name"], "CardView");
        assert!(stored(&store, "muicardview").get("history").is_none());
    }

    #[test]
    fn merge_refuses_self_absent_and_cross_kit_without_removing() {
        let store = tmp_component_store("merge-refuse");
        let dir = store.dir().to_string_lossy().into_owned();
        store.set("a", &serde_json::json!({ "id": "a", "name": "A", "kitId": "k1" }).to_string()).unwrap();
        store.set("b", &serde_json::json!({ "id": "b", "name": "B", "kitId": "k2" }).to_string()).unwrap();
        let refuse = |args: &[&str], needle: &str| {
            let v: Vec<String> = args.iter().map(|s| s.to_string()).chain(["--dir".to_string(), dir.clone()]).collect();
            let err = run(v, "bsc ui").unwrap_err();
            assert!(err.contains(needle), "expected '{needle}' in: {err}");
        };
        refuse(&["merge", "a", "a"], "into itself");
        refuse(&["merge", "ghost", "a"], "no component 'ghost'");
        refuse(&["merge", "a", "b"], "cross-kit merge is unsafe");
        assert!(store.get("a").unwrap().is_some() && store.get("b").unwrap().is_some(), "no refusal removed anything");
    }

    #[test]
    fn merge_is_registered_gated_and_help_reachable() {
        assert!(COMPONENT_COMMANDS.iter().any(|c| c.name == "merge"));
        let a = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_scoped_mutation(&a(&["merge", "a", "b"])), "merge is a mutation");
        assert!(!is_scoped_mutation(&a(&["merge", "help"])), "merge help is not a mutation");
        bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
            let err = run(vec!["merge".into(), "a".into(), "b".into()], "bsc ui").unwrap_err();
            assert!(err.contains("read-only"), "merge refuses read-scoped: {err}");
            assert!(run(vec!["merge".into(), "help".into()], "bsc ui").is_ok(), "merge help reachable read-scoped");
        });
    }

    // ── #4107 slice B: the `group` -> `folder` rename ──

    /// The store holds records written under `group` and there is no migration pass (the component seed
    /// dir is skipped by `ensure_seeded`), so every READ must accept both names. Without this a rename
    /// silently flattens 351 records to "unfoldered" — the failure looks like a kit that never had folders.
    #[test]
    fn record_folder_reads_the_legacy_group_key() {
        use serde_json::json;
        assert_eq!(record_folder(&json!({ "folder": "shared/ui" })), Some("shared/ui"));
        assert_eq!(record_folder(&json!({ "group": "shared/ui" })), Some("shared/ui"), "legacy key still read");
        // Both present ⇒ the CURRENT name wins, so a half-migrated record cannot regress to its old path.
        assert_eq!(record_folder(&json!({ "folder": "new/path", "group": "old/path" })), Some("new/path"));
        assert_eq!(record_folder(&json!({})), None);
        // An empty value is "absent", never a `""` bucket — the record convention the doc pins.
        assert_eq!(record_folder(&json!({ "folder": "" })), None);
        assert_eq!(record_folder(&json!({ "group": "" })), None);
    }

    /// A refolder pass must MIGRATE a legacy record, not just re-derive it: it writes `folder` and drops
    /// `group`, so the record ends up with exactly one name for its folder.
    #[test]
    fn refolder_migrates_a_legacy_record_off_the_group_key() {
        use serde_json::json;
        let dir = tmp_store_dir("refolder-legacy");
        let store = open_component_store(&Some(dir.clone())).unwrap();
        store
            .set(
                "button",
                &json!({ "id": "button", "name": "Button", "kitId": "harvested", "role": "primitive",
                         "group": "shared/ui/controls", "src": "src/shared/ui/controls/Button.tsx" })
                .to_string(),
            )
            .unwrap();

        run(vec!["refolder".into(), "--dir".into(), dir.clone()], "bsc ui").unwrap();

        let rec: serde_json::Value = serde_json::from_str(&store.get("button").unwrap().unwrap()).unwrap();
        assert_eq!(rec.get("folder").and_then(|v| v.as_str()), Some("shared/ui/controls"));
        assert!(rec.get("group").is_none(), "the legacy key is dropped, so the two can never drift");
    }
}

#[cfg(test)]
mod list_kit_tests {
    use super::*;

    /// A store seeded with two kits, so the filter has something real to separate.
    fn seeded() -> (tempdir_shim::Dir, String) {
        let dir = tempdir_shim::Dir::new("bsc-4158");
        let store = open_component_store(&Some(dir.path())).unwrap();
        store.set("a1", r#"{"id":"a1","name":"A1","kitId":"alpha"}"#).unwrap();
        store.set("a2", r#"{"id":"a2","name":"A2","kitId":"alpha"}"#).unwrap();
        store.set("b1", r#"{"id":"b1","name":"B1","kitId":"beta"}"#).unwrap();
        let p = dir.path();
        (dir, p)
    }

    #[test]
    fn list_kit_selects_only_that_kit_and_tolerates_an_unknown_one() {
        // #4158 / designer request #44: comparing two kits' membership used to need a full-store dump
        // and a grep of the auto-persisted tool-output file.
        let (_d, path) = seeded();
        let ids = |kit: &str| -> Vec<String> {
            let store = open_component_store(&Some(path.clone())).unwrap();
            store
                .list()
                .iter()
                .filter(|j| {
                    serde_json::from_str::<serde_json::Value>(j)
                        .ok()
                        .and_then(|v| v.get("kitId").and_then(|k| k.as_str().map(str::to_owned)))
                        .as_deref()
                        == Some(kit)
                })
                .filter_map(|j| bsc_json_store::cli::id_field(j))
                .collect()
        };
        let mut alpha = ids("alpha");
        alpha.sort();
        assert_eq!(alpha, vec!["a1", "a2"]);
        assert_eq!(ids("beta"), vec!["b1"]);
        // An unknown kit is an EMPTY list, not an error — asking about a kit with no components is a
        // legitimate question, and erroring would make "is it empty?" unanswerable.
        assert!(ids("nope").is_empty());
    }

    #[test]
    fn list_kit_requires_a_value() {
        // A bare `--kit` has nothing to filter on; failing loudly beats silently listing everything.
        assert!(cmd_list_kit(&["--kit".to_string()]).is_err());
    }

    #[test]
    fn list_kit_rejects_an_unknown_flag() {
        // Mirrors `list --shape`'s contract, so the two interceptions behave the same way.
        assert!(cmd_list_kit(&["--kit".into(), "alpha".into(), "--nope".into()]).is_err());
    }
}

/// A minimal scoped temp dir for the tests above — the crate has no dev-dependency on `tempfile`.
#[cfg(test)]
mod tempdir_shim {
    pub struct Dir(std::path::PathBuf);
    impl Dir {
        pub fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&p).ok();
            Self(p)
        }
        pub fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }
}
