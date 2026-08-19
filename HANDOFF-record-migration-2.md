# Kickoff — finish the record migration, split across two sessions

Paste this into a fresh session. Everything below was measured, not assumed. Where a number is stale in
the repo's own docs, that is called out rather than quietly corrected.

---

## The one thing to read first

```bash
export BSC_PLAN_DB="$HOME/.base-studio-code/plans/studio-code.db"
bsc plan get adjudicate-the-body-differs-backlog     # the live item
bsc plan get one-file-many-records-blocks-the-last-lifts
bsc plan get a-derivative-record-must-not-claim-the-module-it-derives-from
```

Eleven slices landed as **local branches, none merged and none reviewed**. Every one has a change record
with notes and gate evidence: `bsc plan change render <ref>`.

---

## State of play

`src/` went **388 → 225** non-test modules. The test count has been **670 throughout** — no coverage was
traded away.

The branches stack, each on the one below (except the first, which is independent):

```
342  a54113e2  records-carry-relative-imports-that-break-when-a-neighbour-retires   ← independent
317  929a206d  drain-the-ten-promotable-modules
314  78821d62  the-six-algorithm-seed-nodes-answer-no-specifier
309  c236da85  a-file-opening-with-a-jsdoc-block-grades-as-body-differs
296  5084be26  close-the-composes-closure
293  f68dc618  harvest-the-record-less-logic-modules
283  5a7dbe23  lift-a-component-file-into-a-module-shaped-record
266  7dc5d50c  a-retirement-must-prove-the-seed-answers-the-specifier
240  d422009a  batch-the-remaining-component-lifts
236  799be530  finish-the-component-lifts
225  18513029  retire-everything-the-guards-allow                                   ← wt-cat sits here
```

**`develop` has moved a long way underneath them** (currently `d356e169`, several merges ahead) and five
other sessions are active in other worktrees. Expect a real merge on `scripts/lib/recordSource.mjs` —
the independent branch adds `relativeSpecifiers`/`aliasFor` there while the stack adds `splitPreamble`'s
fix, `seedAdoption`, `seedAnswersSpecifier` and `seedMatchesFile`. Different regions, but not a
fast-forward.

---

## THE SPLIT — and the boundary that makes it safe

The two halves are divided by **who may write the generated artifacts**, because those regenerate rather
than merge:

```
src-tauri/data/components/react-ui.json      ← generated
src-tauri/data/ui/react-ui-kit.meta.json     ← generated
src-tauri/data/ui/platform-modules.json      ← generated
src-tauri/data/knowledge/algorithms.json     ← seed + generated
src-tauri/data/components/app/**             ← the seed
```

### Session A — DOCUMENTATION + RUNTIME VERIFICATION (start here; no generated files)

**This is the higher-value half and it is why this handoff exists.** The plan records are thorough; the
PROSE is stale, and the repo's own `CLAUDE.md` says docs are updated in the same branch as the change.

**1. The counts are wrong in two places.** Measured today: **225** files under `src/`, **447** seed
component records, **605** seed impls (579 TypeScript).

- `CLAUDE.md:149-150` — *"~930 modules ship as RECORDS — 388 component records … plus 542
  implementations"*
- `docs/records.md:3-5` — *"**930 modules ship as records** — 388 component records … and roughly 440 of
  the files that used to hold them have been deleted"*
- `docs/records.md:232` — *"Roughly 96 are `.tsx` whose records are preview-shaped derivatives"* — that
  unlock happened; the number is now different and the mechanism exists (see below).

**2. Six rules were learned this session and NONE is in `docs/records.md`.** Each cost real breakage:

| rule | where it lives now | what it cost to learn |
|---|---|---|
| a retirement must prove the **seed answers the specifier**, matched exactly | `seedAnswersSpecifier` | five modules retired with the old derivative still shipping; `pageheader`'s capital-P `provides` |
| …and that the answer is the **same module** | `seedMatchesFile` | ten test failures — `Dialog`/`ModalCard`/`ModalScrim`/`a11y` retired against divergent seeds |
| a **multi-record file** gets a NEW module record, never one of its component records promoted | `lift-component-module.mjs` | three records silently became whole modules; reverted |
| a module a **build config** imports can never be a record | `retire-module.mjs` | `vite.config.ts` imports `devWatchIgnore`; only `vite build` saw it |
| barrels are addressed **three ways**: `@/x/y`, `…/y/index`, and `from "./"` | `retire-module.mjs` | two separate TS2307 rounds, each after the file was gone |
| the **sixth obligation**: `UPDATE_RECORDS=1 … glancepageRecord.gen` | — | undocumented; breaks whenever `GlanceWorkspace.tsx` moves |

**3. Correct a false claim I made.** The change record for
`records-carry-relative-imports-that-break-when-a-neighbour-retires` originally said *"preview-errors.log
shows the app picking the writes up"*. **That is wrong** — an empty-`message` entry in that log is
written by the CLI on a record write, not by the app. A correction note is already appended; do not
re-derive the wrong conclusion from the log. Entries with a **real message** are renders; empty ones are
writes.

**4. Run the runtime check nobody has run.** Every gate this session was tsc / lint / vitest / clippy /
nextest / `vite build`. **The app has never been booted against these changes.**

```bash
node scripts/dev-boot-check.mjs      # boots vite + Chromium; catches what no test does
```

That is the one outstanding verification, and `docs/records.md` already lists it as part of the
retirement recipe.

### Session B — RETIREMENT (owns every generated artifact and the store)

Continue from `wt-cat` @ `18513029`. **Do not** let Session A touch `src-tauri/data/**`.

---

## The board, characterised

225 modules. **42 must stay files permanently** — do not re-litigate:

```
17  import.meta.glob      a Vite build-time transform; esbuild emits it verbatim, not a runtime function
16  graphPlatform.ts      they register the platform record resolution goes THROUGH — circular
 6  shared/lib/algorithms/*   a node's `code` is GENERATED from the file; that is the standalone guarantee
 2  .d.ts                 ambient, read because INCLUDED, never imported
 1  app/main.tsx          the entry
```

The other ~183 refuse for **one uniform reason** — *no packaged seed provides the specifier* — because the
record exists in the **store** and cannot be **promoted**. Promotion is gated on:

```
59  body-differs        the record and the file genuinely disagree
52  unresolvable        an import cascade that unwinds only as its leaves promote
19  unclosed-composes
 8  role:page           the store refuses a page record that cannot render
```

### The body-differs are already graded — this is the next real work

65 have a file still present:

```
51  store-only, no seed to compare        refresh is a judgement
12  the RECORD has exports the file lacks  do NOT refresh — it would drop them
 1  seed != store (a designer edited it)   escalate
 1  seed == store (never edited)           safe to refresh from the file
```

**And a finding that changes how to read "designer edited it".** 26 of the 65 were last written by
`designer`, which sounds like work to preserve. Sampling four showed the opposite — they are **preview
stubs**:

```
algorithmsgraphhost   3L record vs 19L file:  return <LocalPageFallback page="Algorithms" icon="∑" />;
consolegraphhost      4L record vs 40L file:  return <LocalPageFallback page="Console" icon="▣" />;
```

Those carry `provides`, so they are **live global overrides of the real GraphHosts right now**. That is
the same hazard as `a-derivative-record-must-not-claim-the-module-it-derives-from` (122 records measured
in that state). **But `automationsstatus` is genuinely different** — its record holds an `armedSummary`
function the file does not. So the group is mixed, and "designer wrote it" is not a safe discriminator.
A better one: does the record body contain `LocalPageFallback`?

---

## The guards that now exist — do not re-litigate them, they each caught something

- `retire-module.mjs` refuses: build-config importers · algorithms seed modules · a specifier the seed
  does not answer · a seed that answers but does not match the file.
- `promote-records.mjs --adopt-seed` replaces a stale seed, and **refuses when adopting would drop an
  export the seed declares**. It finds an existing seed **by id, anywhere** — not at a folder-derived
  path (`SEED_COMPONENTS` globs flat).
- Both the component and impl writes refuse a **duplicate id**.
- `libraryCarryClosure` carries a composed LIBRARY record (no `provides`) into the seed so referential
  integrity holds; it never carries an override.
- `lift-component-module.mjs` refuses module state, multi-record files, and reports a store-refused write
  per record instead of throwing.

---

## The six downstream obligations, in order

```bash
node scripts/retire-module.mjs <path>            # 1 rewrites importers · 2 keeps the colocated test
node scripts/sync-shadow-catalogue.mjs           # 3
UPDATE_KITS=1    npx vitest run src/features/designs/lib/platformModules.gen.test.ts   # 5
UPDATE_KITS=1    npx vitest run src/features/designs/lib/reactUiKit.gen.test.ts        # 4  ← kit LAST
UPDATE_RECORDS=1 npx vitest run src/features/glance/glancepageRecord.gen.test.ts       # 6  ← then this
```

**Order is load-bearing.** The kit VENDORS transitive sources, so any later source edit re-fires it. The
glancepage projection must be taken after any revert — regenerating it while a source was still wrongly
rewritten just moved the staleness to the other side.

---

## Traps that cost real time

- **Read the promotion output BEFORE retiring.** A `SKIPPED (a seed already occupies that path)` means the
  seed still holds the old record. Retiring anyway is unrecoverable in place: `promote-records` iterates
  FILES, so once the file is gone the module is no longer a candidate and the stale seed can never be
  adopted. Recovery is restore-from-git → re-promote `--adopt-seed` → re-retire.
- **`bsc ui revert` restores `srcText` only.** Clearing a `provides` it added is a separate explicit write.
- **Never `git checkout -- src/` to "clean up".** A `--dry` run writes nothing; that reflex reverted a
  whole slice's retirements.
- **Windows hides case bugs.** `pageheader` provided `…/PageHeader` against a `pageHeader.tsx` file; tsc,
  the build and the whole suite were green. The loader matches exactly.
- **Do not run `emit-records` or `vite build` concurrently with the gate** — both write `.bsc-records/`.
- **A vitest flake has appeared twice** — once `1 failed` with the name lost to a narrow grep, once a step
  reporting FAIL while its own summary read all-passing. Both times a standalone re-run was clean. Capture
  the failing test NAME before re-running.
- Use the Edit tool for anything with backticks or backslashes; `node -e` through bash mangles them, and a
  `python - <<EOF` heredoc will hang waiting on stdin.

---

## Definition of done

The file count is **not** the measure — 42 modules stay by design. Done is:

1. `docs/records.md` and `CLAUDE.md` describe what is actually true.
2. `dev-boot-check.mjs` has been run and the app boots.
3. Every remaining module is in a **named** category with an owner, not an undifferentiated backlog.
4. The eleven branches are reviewed and merged, or explicitly rejected.

Item 4 is the real risk. Three of this session's defects were in guards written earlier in the same
session — the tooling has been correcting tooling, with no second actor having looked at any of it.
