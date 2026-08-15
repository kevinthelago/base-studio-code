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
- **Import `@data/*.json`.**
- **Be a `.d.ts`.** Ambient declarations are read because they are *included*, never imported — no resolver
  substitutes a record. Retiring `src/vite-env.d.ts` broke the entire typecheck on unrelated files.

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

**Keep the colocated test.** Its relative import is rewritten to `@/…`, after which it tests the record
that actually ships — better coverage than it had. Deleting it moves the assertions into the record's
`tests` data, where nothing in the gate executes them; that cost 31 assertions before anyone noticed.
`retiredTests.test.ts` enforces it.

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
