# Records — when a module is not a file

Most of this app's frontend no longer exists as files. **1,094 modules ship as records** — 469 component
records under `src-tauri/data/components/app/**` and 625 algorithm implementations in
`src-tauri/data/knowledge/algorithms.json`, of which **895 carry a `provides`** and so answer a specifier
an importer writes. **100 non-test modules remain under `src/`**, down from 388. This is epic #3604,
"the graph IS the app".

> Those numbers move every tranche, and a stale one here is worse than none — this document went eleven
> slices describing a tree that no longer existed. Re-measure rather than trust the prose:
>
> ```bash
> find src -name "*.ts" -o -name "*.tsx" | grep -vE "\.(test|spec)\." | wc -l   # files left
> find src-tauri/data/components/app -name "*.json" | wc -l                     # component records
> ```

If you have opened `src/` looking for a module and it was not there, this document is why, and what to do
instead.

---

## Finding a module that is not a file

```bash
bsc ui list --full                 # every component record, with its source
bsc ui get <id>                    # one component record
bsc graph impl list                # every algorithm implementation
bsc graph impl get <id>            # one implementation
```

A record claims the module it stands for through **`provides`** — the `@/…` specifier it answers. So the
question "where did `@/shared/ui/layout/Spacer` go?" is answered by finding the record whose `provides` is
that specifier, not by searching the filesystem.

To **edit** a retired module you edit the record, not a file:

```bash
bsc ui set --by <you> --note "<why>"      # component JSON on stdin, MERGED into the record
bsc graph impl set --id <id> --tech typescript --role algorithm --code "<source>"
bsc ui revert <id> [--to <rev>]           # records keep history; writes are revertible
```

New UI is authored **into the store**, never as a new `.tsx`.

---

### Naming a module in prose

**Name a module by its specifier, not by a file path** — `@/features/planner/fleet/agentFlow`, not
`src/features/planner/fleet/agentFlow.ts`. The specifier is what the module *is*; the path is only where it
used to live, and writing the path asserts a file exists. Several docs said `…/agentFlow.ts` long after that
file was gone, which sends a reader looking for something deliberately deleted.

`docLinks.test.ts` catches broken markdown **links**, but a backticked path in prose is not a link and
nothing checks it. The specifier form is what keeps it true.

## Seed vs store — the distinction everything else depends on

There are two copies of every record and they are not the same thing.

| | what it is | where |
|---|---|---|
| **seed** | what SHIPS. Checked into git, identical for everyone. | `src-tauri/data/components/app/**`, `src-tauri/data/knowledge/algorithms.json` |
| **store** | your machine's live working copy, edited by the app and by designer sessions. | `~/.base-studio-code/…` via `bsc ui` / `bsc graph` |

`scripts/emit-records.mjs` materializes **the seed** — never the store — into a git-ignored `.bsc-records/`
tree, which is what the compilers resolve against. So:

- A record that exists only in your **store** cannot retire its file. It has to be **promoted** into the
  seed first, or the module vanishes for everyone else.
- The two drift, in both directions. A designer edits the store; a merge moves the file. Never assume one
  is authoritative — `scripts/retirement-candidates.mjs` grades the three-way (seed vs store vs file), and
  that grade is the whole safety story.

`reconcileSeed` pushes a changed seed into a pristine store copy on boot, and keeps a user-edited copy with
a notice. A **duplicate id** in the seed breaks this: `SEED_COMPONENTS` globs the tree flat and keys by id,
so two records under one id are reported changed and re-pushed on **every boot, forever**, while the app
keeps working. `seedRoundTrip.test.ts` guards it.

---

## The resolvers — every one of them has to know

A retired module resolves through `.bsc-records/`. There is no single place to configure that; each tool
has its own resolver, and **each of these was discovered by a separate failure**:

| resolver | where | discovered by |
|---|---|---|
| tsc | `tsconfig.json` → `"@/*": ["./src/*", "./.bsc-records/*"]` | the original migration |
| vite (app + dev server) | `vite/bscRecords.ts` plugin | — |
| **the vite WORKER sub-build** | `vite.config.ts` → `worker.plugins` | only `vite build` sees it; tsc and vitest stay green |
| vitest | `vitest.config.ts` | a different config file, so the plugin has to be installed twice |
| the Playwright harness | `e2e/vite.config.ts` | retiring `Spacer` broke the whole e2e suite |
| the kit generator | `reactUiKit.gen.test.ts` | — |
| `bsc ui emit` (Rust) | `crates/bsc-ui/src/emit.rs` | **still broken** — see `bsc-ui-emit-cannot-resolve-a-retired-module` |

`src/app/runtime/recordResolvers.test.ts` asserts the list, so the next one added is not found the hard way.

Two properties of that plugin are load-bearing and non-obvious:

- **Emission happens once per process**, shared across plugin instances. `emitRecords` starts by deleting
  the tree, and a worker sub-build's `buildStart` fires *inside* the main build's transform phase — so a
  second emitter deleted `.bsc-records/` while rolldown was reading from it. It failed naming a *different*
  module every run, for files that were plainly on disk by the time anyone looked.
- **The query string is carried through.** `@/app/lazyWorkspaces.tsx?raw` must resolve; the probe tries the
  exact path first (via `isFile`, so a bare `@/features/planner` cannot resolve to a directory).

---

## What a RECORD may not do, though a FILE may

A record is compiled and required by the runtime loader, not just bundled. That imposes limits a file never
had. Every one of these has cost a real failure:

- **Import relatively.** Records carry absolute `@/…` specifiers — see [below](#a-record-may-not-import-relatively-both-copies).
- **Import a stylesheet.** Retiring 10 modules silently stopped 10 CSS files from shipping, with every gate
  green — `main.tsx` now globs `@/**/*.css` to compensate, guarded by `styleReachability.test.ts`.
- **Use `import.meta.glob`.** A Vite build-time transform; esbuild emits it verbatim and it is not a
  function at runtime. 11 modules are held back by this.
- **Be a `.d.ts`.** Ambient declarations are read because they are *included*, never imported — no resolver
  substitutes a record. Retiring `src/vite-env.d.ts` broke the entire typecheck on unrelated files.
- **Be imported by a BUILD CONFIG.** `vite.config.ts` imports `./src/shared/lib/core/devWatchIgnore`, and
  Vite bundles its own config *before* any plugin runs — so `vite/bscRecords.ts` is not installed yet,
  `.bsc-records/` cannot serve it, and there is no `@/` alias out there either (the config sits outside
  `src/` and imports by relative path). `tsc`, `lint` and all 742 vitest files went green after that
  module was retired; only `npx vite build` failed. `retire-module.mjs` now refuses one, reading the
  importer list from the configs rather than a hard-coded name.

**`@data/*.json` used to be on that list and no longer is.** The platform registry serves those
specifiers (`appModules.ts` globs `@data/**/*.json` eagerly), so a record may import packaged data like
any other module. It was never a real limitation — only an absent registration that the docs had
written down as a rule, and 35 modules were held back by it. `dataJsonReachability.test.ts` scans real
source for the specifiers importers actually write and requires the registry to answer each, so the
census re-runs every suite instead of being asserted once.

And two whole categories of module must stay files:

- **`graphPlatform.ts`** — they register the platform that record resolution goes *through*. Circular.
- **A registered module holding module state** — `provides` beats the platform registry, so a record of a
  stateful module vendors a **second copy of that state** to every consumer. `renderGate`'s `lastGood`,
  `theme`'s `activeThemes`, `announcer`'s `useAnnouncer`. `bsc graph harvest` refuses these; a bare
  `impl set --provides` does not, so do not hand-write the claim.
- **`src/shared/lib/algorithms/*.ts`** — these exist precisely to BE files. `seedAlgorithms.gen.test.ts`
  generates a packaged node's `code` *from* the module, so tsc checks it and its sibling test executes it.
  Retiring one turns that guarantee back into a claim.

---

## A record may not import relatively (both copies)

```bash
npm test -- src/app/runtime/recordImports.test.ts   # the SEED — in git, runs on a fresh clone
node scripts/check-record-imports.mjs               # the STORE — per-machine; exit 1 on any finding
node scripts/check-record-imports.mjs --fix         # ...and repair it
```

`makeRequire` routes a specifier to the registry under its **literal key**, so `./useDockBack` needs a
registration exactly like an absolute one — and `provides`, which matches the exact specifier, can never
reach it. A relative specifier in a record therefore only ever *appeared* to work, and only while the
neighbour was still a file a bundler could resolve.

**The store is the copy that breaks the app, and the one a test cannot cover.** A migrated page renders
from the store, not the seed, so that is where a bad specifier is visible — and a test reading
`~/.base-studio-code` would be vacuous on a fresh clone. Hence two runners over one scanner
(`relativeSpecifiers` in `scripts/lib/recordSource.mjs`, shared with `emit-records.mjs` and
`retire-module.mjs` so the guard and the tools that rewrite cannot disagree).

Measured the first time both ran: the seed was clean, the store held **57 relative specifiers across 24
records**, and every gate was green. `platformBoundary.test.ts` had rejected the rule since #4232 but
read one surface — seed *components*, `from "…"` statements only — so algorithm implementations, the
inline `import("../x").Type` form, and the whole store sat outside it.

> **Repairing the imports alone would have made it worse.** `pruneUnsatisfiableOverrides` declines an
> override *only while* its closure cannot resolve, so absolutizing the specifiers PROMOTES a record
> from "declined, falls back to the bundled module" to "active global override". Eleven of the 24
> disagreed with the file they shadow and seven of those carried `provides` — every one a preview-shaped
> derivative: `issuerow` and `issuedrawer` inject a `SAMPLE_ISSUE`, `projectssummary` vendors a fake
> `useProjectsSummaryData` returning four hardcoded projects, `kitrenderer` swaps the real `primitiveFor`
> for `componentFor`. Activating them puts sample data on live screens. So `--fix` **drops `provides`**
> from a record whose body differs from its live file, which is just the rule below applied — and it
> drops it *before* rewriting, because the app is running while the script writes.

**A carried test is the one exemption**, deliberately. It is harvested beside its module saying
`./LabelChip`, and `emit-records.mjs` both rewrites that on emit *and* uses it to verify the test is
paired with the right module — so the relative form is load-bearing at rest. What must hold is that
nothing relative survives into `.bsc-records/`, which `recordImports.test.ts` asserts against
`planRecords()` rather than re-deriving.

## `provides` is a GLOBAL override

The runtime consults records **before** the platform registry. A record claiming `@/app/chrome/Titlebar`
wins over the real module for every runtime-compiled consumer.

That makes an incomplete record actively dangerous rather than merely wrong: three records were found
claiming a specifier while **missing exports their file has**, so consumers got `undefined`. The loader's
decline-and-fallback net does not catch this — it declines overrides that fail to **compile**, and these
compile perfectly with the export simply absent.

If a record is not the whole module, **drop its `provides`**. The record survives for provenance; the
specifier goes back to resolving against the registry.

---

## Retiring a file

```bash
node scripts/retirement-candidates.mjs          # the census — grades every candidate
node scripts/retirement-candidates.mjs --all    # ...including the ones that are NOT safe
```

The census is the authority. Only `same` and `reformatted` are safe; `BODY-DIFFERS` means retiring would
ship the record's behaviour under the file's name, **and it compiles either way**.

When the record is behind and nobody edited it, refresh it from the file. When the file is behind, the
record wins and you adjudicate by hand:

```bash
node scripts/refresh-drifted-seeds.mjs --store <ui-dump> --impls <impl-dump> [--apply]
node scripts/lift-component-module.mjs <src-relative-path>… [--apply]   # a .tsx → a module-shaped record
node scripts/promote-records.mjs --store <ui-dump> --impls <impl-dump> [--apply] [--adopt-seed]
node scripts/retire-module.mjs <src-relative-path>
node scripts/sync-shadow-catalogue.mjs          # a catalogued page must become `file: null`
node scripts/fix-stale-mocks.mjs                # see below
node scripts/check-record-imports.mjs           # the RECORD half — `retire-module.mjs` runs this too
node scripts/dev-boot-check.mjs                 # boots vite + Chromium; catches what no test does
```

**READ THE PROMOTION'S OUTPUT BEFORE RETIRING.** A `SKIPPED (a seed already occupies that path)` line
means the seed still holds the OLD record, and retiring anyway is unrecoverable in place: this script
iterates FILES, so once the file is gone the module is no longer a candidate and the stale seed can never
be adopted. Recovery is restore-from-git → re-promote with `--adopt-seed` → re-retire. `--adopt-seed`
replaces a stale seed with the store record, and refuses when doing so would drop an export the seed
declares.

### The SIX downstream obligations, in this order

```bash
node scripts/sync-shadow-catalogue.mjs                                                   # 3
UPDATE_KITS=1    npx vitest run src/features/designs/lib/platformModules.gen.test.ts     # 5
UPDATE_KITS=1    npx vitest run src/features/designs/lib/reactUiKit.gen.test.ts          # 4  ← kit LAST
UPDATE_RECORDS=1 npx vitest run src/features/glance/glancepageRecord.gen.test.ts         # 6  ← then this
```

(1 and 2 — rewriting importers and keeping the colocated test — are what `retire-module.mjs` itself does.)

**The ORDER is load-bearing.** `react-ui.json` VENDORS the transitive sources its components import, so
any later source edit re-fires the kit regeneration — regenerating the kit and *then* fixing an importer
turns it red again. The glancepage projection is last for the same reason and one more: Glance renders
the RECORD, so the projection must be re-taken after any revert. Regenerating it while a source was still
wrongly rewritten only moved the staleness to the other side.

### The colocated test — either copy may run, but one of them must

A retired module's tests have to keep **executing**. There are two ways to satisfy that, and the rule is
only that you pick one:

| | what runs | when to choose it |
|---|---|---|
| **keep the file** | `src/x/y.test.tsx`, its relative import rewritten to `@/…` | the record's carried copy is stale, mispaired, or the test is not about a single module |
| **delete the file** | the record's `tests[]`, materialized into `.bsc-records/x/y.test.tsx` | the carried copy is the same test — the graph then holds the module *and* its test |

`emit-records.mjs` materializes carried tests beside the module they test, and `vitest.config.ts`
includes `.bsc-records/**`, so the carried copy runs in the default gate against the record that actually
ships. **`src/` wins while it exists** — a record's copy is emitted only once the file is gone, so the
same assertions never run twice, and deleting the file is the entire handover.

> This reverses the earlier rule ("retire the module, keep the test"). That rule was right for as long as
> nothing could RUN a carried test: deleting a file then traded executed coverage for stored coverage,
> silently and green, which cost 31 assertions across the first two tranches. It was a consequence of a
> missing executor, not a statement about where a test belongs.

`retiredTests.test.ts` enforces that a retired record's tests execute **somewhere**, and asks
`planRecords()` rather than re-deriving the answer so it cannot drift from the emitter.

**Check the carried copy before deleting the file** — the two drift, and the file is usually the newer
one. Of the first 48 candidates, 46 differed only in the import specifier (safe), and **2 had extra
assertions the record never got** — `@/shared/ui/layouts/Screen` carried a whole extra test (#4167) that
deleting the file would have thrown away, on a green gate.

Two things the emitter refuses, loudly rather than silently:

- **A mispaired test.** `bsc ui harvest` attached whatever colocated test it found, so records exist
  carrying a test for something else entirely (`@/components/typechip` holds the `ScanViews` test; four
  records share one `bodyStyles` test). Every relative import is checked against what is actually being
  emitted, and a test that fails is reported with the import that disqualified it.
- **An unrewritten relative import.** A carried test says `./LabelChip`; emitted into `.bsc-records/`
  that reaches nothing when `LabelChip` is still a file, because the two trees are not bridged
  relatively. They are rewritten to `@/…` on emit — the same rewrite `retire-module.mjs` applies to the
  file copy, so both copies of a test resolve identically.

### Traps that cost real time

- **`vi.mock("./x")` breaks silently.** A mock keys on the resolved module. While the file exists, a
  consumer's `@/a/b` and a test's `./b` are the same module; retire it and they stop agreeing, so the mock
  stops applying and the test runs against the real module — still passing, just weaker.
- **The deletion gate is the BUNDLE.** `typecheck`, `lint` and `vitest` all go green with a live worker
  entry deleted. Only `vite build` sees `new URL('./x.ts', import.meta.url)`.
- **A module id comes from the FILE STEM.** `store/types/plan.ts` and `store/slices/plan.ts` collide, and
  `impl set` merges by id — one harvest silently overwrote a curated algorithm this way.
- **A capability list must be canonical.** `injectCallers.test.ts` (the `pty_write` allow-list) keyed on
  the raw path, so every retirement dropped an entry. It keys on the module now.

---

## Retiring a file — the PRECONDITIONS

A file may be deleted only once the thing that **ships** answers what its importers ask for. Both halves
of that are checked by `retire-module.mjs`, and each was learned by shipping the bug first:

- **The packaged SEED must provide the specifier**, matched EXACTLY, case included. Five modules were
  retired while `promote-records` had printed `SKIPPED (a seed already occupies that path)` — deleted,
  with the old derivative still shipping. And `pageheader`'s seed said `@/shared/ui/pages/PageHeader`
  against a `pageHeader.tsx` file: Windows resolves that case-insensitively, so tsc, `vite build` and the
  whole suite stayed green while a case-sensitive filesystem would have resolved to nothing.
- **…and that answer must be the SAME MODULE.** A seed can answer the specifier while holding different
  code, and deleting the file then ships the RECORD's behaviour under the file's name — silently,
  because it still compiles. `Dialog`, `ModalCard`, `ModalScrim` and `a11y` were body-differs records
  that happened to be seeded; retiring them swapped the app's focus management for the records' older
  copies and cost ten test failures in one sweep.

Two more refusals, for whole categories rather than for a state:

- **A module a BUILD CONFIG imports can never be a record.** `vite.config.ts` does
  `import { devWatchIgnored } from "./src/shared/lib/core/devWatchIgnore"`, and Vite bundles its own
  config *before* any plugin runs — so `vite/bscRecords.ts` is not installed yet, `.bsc-records/` cannot
  serve it, and there is no `@/` alias out there either. `tsc`, `lint` and all 742 vitest files went
  green after that module was retired; only `npx vite build` failed.
- **An algorithms seed module stays a file** — see the list above. The census had excluded them since
  `llmEnergy.ts` went in an early tranche; the tool that actually *deletes* had not.

### A barrel is addressed THREE ways

`lib/plannerCore/index.ts` answers `@/features/planner/lib/plannerCore` — never `…/plannerCore/index`,
because `specOf` strips a trailing `/index` and that is what the record `provides`. An importer may write
any of `@/features/planner/lib/plannerCore`, `./plannerCore/index`, or the bare directory form
`from "./"`. Each of those three was discovered separately, and each after the file was already gone:
the first rewrote three importers onto a specifier nothing answered, the third left `charts.test.tsx`
importing `from "./"` and typecheck reporting `Cannot find module './'`.

## One file, many records

`bsc ui harvest` lifts a *component*, so a file exporting several of them has several records pointing at
it — `AppBanners.tsx` has NINE, `Charts.tsx` five. Such a file is genuinely both: nine banner components
AND one module, and the store can hold both.

**Do not promote one of the component records into the module.** Picking is what a `Map` keyed by `src`
did silently — it kept whichever came last, so `telemetrypanel` became the whole of `telemetry.tsx` while
`itembars` and `splitbar` went on claiming their own identity, and a consumer asking for
`@/components/splitbar` would have got a module whose export pick is not that component. Three records
reached the seed that way before the adopt guard caught the rest.

Author a **new** module record beside them (`scripts/lift-component-module.mjs`, id `<stem>-module`,
`role: composite`). The components keep answering `@/components/<id>`; the module record answers
`@/features/x/Y`. Nothing is overwritten, so no component record loses an export it declares.

## Where this is going — and the floor it stops at

The `--module` unlock is **built and spent**. `bsc graph harvest --module` plus
`scripts/lift-component-module.mjs` turned the preview-shaped derivatives into faithful module records,
and the sweeps that followed took `src/` from 225 modules to **100**. What is left is not one blocker,
and most of it is not backlog.

> Counts drift every tranche and a stale one is worse than none. Re-measure:
> `git ls-files src | grep -E '\.tsx?$' | grep -vcE '\.(test|spec)\.|\.d\.ts$'`

### The floor, measured

| count | class | why a record cannot stand for it |
|---|---|---|
| ~31 | **modules with MODULE STATE** | a record is a SECOND instantiation, so it vendors a second copy of that state to every consumer. `provides` beats the platform registry, so the copy WINS — this is the failure that made the a11y announcer go silent. `bsc graph harvest <f> --module` reports it as `moduleState`, and `lift-component-module.mjs` refuses on it |
| 18 | `import.meta.glob` | a **Vite build-time transform**. esbuild emits it verbatim and it is not a function at runtime, so the record throws the moment a consumer evaluates it |
| 16 | `graphPlatform.ts` registrars | they are what REGISTERS records; a record cannot register itself. (Not absolute — `tunnel`/`teams`/`designs` registrars ARE records already. The ones that remain are the ones a record would have to load through) |
| 12 | feature `index.ts` barrels | two sub-cases. `features/planner/index.tsx` and `features/settings/index.tsx` exist to run `register*Platform()` **at import**, which is the registry a record is loaded *through*; the rest are statically imported by `App.tsx` (below) |
| 7 | type-only (`store/types/*`) | they emit no JavaScript, so there is nothing for a record to be |
| 6 | `shared/lib/algorithms/*` | the node's code is GENERATED from the file — retiring it turns the standalone guarantee back into a claim (`seedAlgorithms.gen.test.ts`, #3465) |
| 3 | `shared/lib/runtime/*` | the loader that resolves records. A record cannot load itself |
| 1 | `app/App.tsx` | the entry, plus whatever it imports **statically** (below) |

Two smaller classes behave the same way and are enforced by `scripts/retire-module.mjs` rather than
counted above: a module **statically imported by `main.tsx`/`App.tsx`** (the dev server's pre-transform
pass resolves the alias before the records plugin can answer, so the app fails to boot — and only
`dev-boot-check.mjs` observes it), and a module imported by a **build config** such as `vite.config.ts`
(bundled before any plugin runs, and only `vite build` observes it).

**Measure module state; do not eyeball it.** The 31 above were found by running
`bsc graph harvest <file> --module` over every remaining candidate and reading the `moduleState` field —
`log.ts` holds `scopeThreshold,scopesFetchedAt,queue,flushTimer`, `theme.ts` holds `activeThemes`,
`launchGate.ts` holds `chain,launched`. None of that is visible from the module's name or its role, and
several read as obviously-pure utilities.

**The floor is load-bearing for everything above it.** What remains does not fail for want of a harvest —
it bottoms out ON that floor, through its dependencies:

```
app/runtime/shadowMode.ts        → needs @/app/runtime/shadowPages      ← import.meta.glob, permanent
features/planner/stages/blueprints.ts → needs …/blueprintBuiltins       ← import.meta.glob, permanent
store/slices/plan.ts             → store/types.ts needs @/store/types/… ← type-only, permanent
```

So `promote-records.mjs`'s *unresolvable import* bucket is largely this one fact wearing another name.
Closing it is not more sweeping; it is answering **how a record depends on a permanently-file module**,
which is the question `graphPlatform.ts` already answers for the registrars and which nothing yet
answers generally.

### Traps this campaign paid for

Each of these cost a wrong turn, and none of them is visible from the tool's output alone.

- **A bigger seed is not a staler seed.** Three Glance components had a seed record LARGER than the file
  — the shape that had already nearly deleted two shipped features. It was not stale: it was the
  **graph-source** copy, the same body with sibling imports spelled `@/components/<id>`, which only the
  runtime loader resolves. `provides` was null, so the record served the loader and the file served the
  bundle, both live and deliberately. **Diff before adopting**, and take a full-store baseline
  (`bsc ui list --full`) before any lift — it is the only thing that can answer *did I change something
  I did not mean to*.
- **The `-module` convention.** When a file has a graph-source record, the retirement is not an
  overwrite: author a SECOND record `<id>-module` carrying `provides` and file-specifier imports, with
  `lift-component-module.mjs --new-record`. `glance-preview-morph` already shipped exactly that way.
- **`worthy: false` does not disqualify a record.** That rubric is about LIBRARY membership — *is this a
  reusable algorithm?* — not about whether a record can back a retired file. The graph already carries
  app glue (`tunnel-graph-platform.ts` is an impl record with `provides`), and *the graph IS the app*
  means app-specific modules belong there. What actually gates a retirement is: does it compile, and
  does every specifier resolve. Five of six "unworthy" modules retired in one pass.
- **The `no record` bucket is not a dead end.** `lift-component-module.mjs` refuses to invent a record
  (correctly — a duplicate id in the flat `SEED_COMPONENTS` glob), but `bsc graph harvest --module
  --apply` **authors** one. That is the path for a module with no record at all.
- **An unregistered third-party package blocks a retirement**, and the error does not say so: *"needs
  `qrcode.react`"* reads like a missing dependency, and it was in `package.json` all along. `makeRequire`
  demands EVERY specifier be registered, bare or first-party (#4224). Register it in the OWNING feature's
  graph-platform, never `appModules` — registration is eager, and the shell's set would put a QR renderer
  in the boot bundle for every user who never pairs a phone.
- **A record whose file already retired is invisible to `promote-records.mjs`.** It only promotes records
  whose FILE still exists; anything else counts as *already seeded* and is never reconsidered. So an edit
  via `bsc graph impl set` lands in the store and **stops** — `.bsc-records/` is emitted from the SEED, so
  the app keeps shipping the old body with no error anywhere. `scripts/sync-impl-seed.mjs` closes that,
  BY ID and never as a sweep (seed and store have diverged both ways across ~340 records). The sequence
  that works: `impl set --code-file` → `sync-impl-seed --apply` → `emit-records` → `UPDATE_KITS=1
  platformModules.gen` → `promote` → `retire`.
- **`--code-file`, never `--code`.** The CLI's own help says it: source on the command line is corrupted
  SILENTLY — a backtick or a `${…}` is substituted away, a literal `\n` never becomes a newline — and
  large modules exceed the argv limit. Note also that `bsc graph impl set` takes FLAGS while `bsc ui set`
  takes stdin JSON.
- **A promote error can name a specifier the module never imports.** `runtimeImports` gaps the keyword to
  `from` with `[^"']*`, which crosses newlines — it must, so a wrapped clause still matches — so a match
  can start on a real statement and run several lines into a doc comment. `nodeUrn.ts` was blocked by
  ``(`import { fibonacci } from "@bsc/algorithms/fibonacci"`)`` written as an EXAMPLE. Fixed by stripping
  comments first; `platformBoundary.test.ts` imports the same function, so guard and promoter move
  together by construction.
- **Promoting a record obliges you to promote its closure.** Packaging `settings-mcp` while
  `@/features/settings/cards/ClaudeConfigCard` was still a file left a record the runtime loader cannot
  load — the bundle resolves that path through vite's tsconfig `paths`, so `tsc`, `lint` and `vite build`
  were all green. Only `platformBoundary` saw it, because the loader has no src-file route.

### What genuinely remains

- **`role: page` records** (2 — `DataGraphPage`, `NetworkPage`). A page record imports its siblings **by
  record id**: `@/components/algorithms-kit-graph`, not `@/features/algorithms/AlgorithmsKitGraph`. That
  form is resolved by the runtime graph loader against the record store; it is not a path. Retire the file
  and `.bsc-records/` materializes the record at that path, where the first ordinary import of it dies.
  Cataloguing one in `SHADOW_PAGES` is therefore not a formality — it declares the app renders that page
  FROM the graph, which `shadowPages.test.ts` reads back from `lazyWorkspaces.tsx`. That is a
  page-to-graph migration per page, a different kind of work from a harvest.

  (This is what `promote-records.mjs` is really refusing when it skips `role: page` wholesale; the ban is
  not about pages being special. `retire-module.mjs` states it directly via `importsSiblingsByRecordId`,
  because the category ban was circumventable and the reason was not written down: four page files were
  retired past it on the theory that the record "matched" its file once sibling ids were canonicalized —
  true in the graph loader, false in the bundle. Every other gate was green; `platformModules.gen.test.ts`
  was the only check in the repo that caught it.)
- **Records and files that genuinely disagree** (8 body-differs). Only a person can say which one is
  the app.
- **One record that cannot compile as TSX** (`vizSandbox.ts`) — see the TSX-is-not-a-superset note above.
