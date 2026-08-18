# Records — when a module is not a file

Most of this app's frontend no longer exists as files. **930 modules ship as records** — 388 component
records under `src-tauri/data/components/app/**` and 542 algorithm implementations in
`src-tauri/data/knowledge/algorithms.json` — and roughly 440 of the files that used to hold them have been
deleted. This is epic #3604, "the graph IS the app".

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

- **Import relatively.** Records carry absolute `@/…` specifiers. `retire-module.mjs` rewrites importers.
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
node scripts/promote-records.mjs --store <ui-dump> --impls <impl-dump> [--apply]
node scripts/retire-module.mjs <src-relative-path>
node scripts/sync-shadow-catalogue.mjs          # a catalogued page must become `file: null`
node scripts/fix-stale-mocks.mjs                # see below
node scripts/dev-boot-check.mjs                 # boots vite + Chromium; catches what no test does
```

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

## Where this is going

The remaining files are not blocked on mechanism. Roughly 96 are `.tsx` whose records are **preview-shaped
derivatives** — `bsc ui harvest` lifts a *component*, inlining what it cannot reach so the thing mounts
standalone in the Design Studio, which is right for previewing and wrong for retirement. The unlock is a
`--module` mode for `bsc ui harvest`, the component-store twin of `bsc graph harvest --module` (#4161).

The rest need human judgement: a record and its file that genuinely disagree, where only a person can say
which one is the app.
