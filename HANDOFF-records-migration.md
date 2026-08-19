# Kickoff — records migration, and a defect that must be fixed before more retirements

Paste this into a fresh session. Everything below was measured, not assumed.

---

## Start here

```bash
export BSC_PLAN_DB="$HOME/.base-studio-code/plans/base-studio-code.db"
bsc plan get records-carry-relative-imports-that-break-when-a-neighbour-retires
```

**Do that item first.** It is a live defect, and it blocks the rest of the campaign.

---

## The defect (the reason for this handoff)

The maintainer reported the app broken by a record whose source pointed at a deleted file. Diagnosing it
found something larger. Against the live store (626 records):

```
relative imports inside record srcText : 51
  target still a FILE on disk          : 18   <- LATENT: breaks when that file is retired
  target already GONE                  : 33   <- ALREADY BROKEN
```

Examples: `app → ./useFleetWakeBridge, ./useDebugChannel, ./useDockBack`,
`componentpreviewframe → ./usePreviewData`, `graphcomponent → ./graphResolver`, `issuerow → ./issuesModel`.

**Why it is a defect.** `docs/records.md` lists *"import relatively"* first among the things a record may
not do: a record is resolved by the runtime loader against the platform registry and the record store,
never against a directory. A relative specifier only ever *appeared* to work while the neighbour was
still a file. Retiring that neighbour arms the trap.

**The gap.** `retire-module.mjs` rewrites relative importers **in `src/` files** — which is why every
tranche gated green. **Nothing rewrites relative imports inside RECORDS**, in the store or the seed. The
file half of the codebase is maintained; the record half silently is not.

**Nothing in the gate sees it.** tsc, lint, vitest, the kit test and `platformBoundary` all passed on
every tranche while 33 records were already broken.

### Not caused by the recent work — verified, not assumed

- None of the 15 broken targets appears among the 53 modules retired today (`comm -12` over the two sets
  is empty).
- All 47 records authored today carry **zero** relative imports.
- These date from the earlier 388-record migration.

That does **not** make it someone else's problem: each new retirement can arm one of the 18 latent ones,
which is the plausible link to the reported symptom. **I could not reproduce the maintainer's specific
breakage** — no app log existed at `~/.base-studio-code/base-studio-code.log` — so treat the report as
real evidence whose exact record is still unidentified.

Reproduce the census with the two scratch scripts (paths in the plan item's notes), or re-derive it: scan
every record's `srcText` for `from "./…"`, resolve against the record's own `src` dir, and check whether
the target still exists.

---

## Repo state

`develop` is at the merge of `author-records-for-the-39-settings-cards`.

| | start of session | now |
|---|---|---|
| non-test files | 386 | **327** |
| test files | 670 | **670** — none lost |

**59 files retired across five merged slices.** One slice is **committed but deliberately NOT merged**:

```
fe0311d7  feat(records): author SettingsControls — one 59-line module unblocks 14
          branch: settingscontrols-blocks-fourteen-modules   worktree: wt-cat
          gate: all five PASS (exit 0).  vite build: NOT yet run for this slice.
```

It is held back because adding 15 more retirements while the record-import defect is unfixed can arm more
latent breakage. Its own 15 records are clean. **Merging it is a judgement call for the maintainer** — the
work is sound, the timing is what is in question.

---

## The pipeline (proven end to end today)

```
edit → harvest → ui set → promote → seed → retire → regenerate → gate
```

**Logic modules** (`.ts`): `bsc graph harvest <file> --module --apply` writes straight to the store.

**Components** (`.tsx`): there is no one-step path.
```bash
bsc graph harvest <file> --module          # module-shaped, carries `provides`
# reshape to a COMPONENT record: {id, name, kitId:"base-studio-code", role, provides,
#                                 srcText:<candidate.code>, composes, src, folder}
cat rec.json | bsc ui set                  # from a FILE or stdin — NEVER argv
```

**`bsc ui harvest` is the WRONG TOOL and must not be used for this.** It lifts each React *component*, not
each module (`AgentRolesCard.tsx` yields `agentrolescard` AND `rolerow`, neither of which is the module),
emits **no `provides`** — the field that makes a record supersede its module — stamps `kitId: "harvested"`,
and returned `buildable:false` for 18 of 47. Records built from it can never retire anything.

### Five downstream obligations after any retirement

`retire-module.mjs` documents all five; three were there, two were added today after tranches went red:

1. rewrite relative importers (the tool does this, **for `src/` files only** — see the defect above)
2. **keep** the colocated test, rewriting its import and any `vi.mock("./x")` — a mock keys on the
   *resolved* module and silently stops applying otherwise
3. `node scripts/sync-shadow-catalogue.mjs`
4. `UPDATE_KITS=1 npx vitest run src/features/designs/lib/reactUiKit.gen.test.ts` — the kit **vendors**
   the transitive sources you just deleted
5. `UPDATE_KITS=1 npx vitest run src/features/designs/lib/platformModules.gen.test.ts` — a retired module
   becomes a specifier the registry serves (a 23-card tranche took it 974 → 997)

---

## Traps that cost real time today

- **Never run `emit-records` (or `vite build`) concurrently with the gate.** Both write `.bsc-records/`;
  two writers made typecheck fail with `TS2307` on paths *inside the generated tree*. The tell: every
  failing path was under `.bsc-records/`, not `src/`. Re-running alone was exit 0.
- **`--outfile=/dev/null` in Git Bash on Windows writes a real file named `nul`**, which git cannot index
  (`error: unable to index file 'nul'`). It broke a commit.
- **`react-ui.json` + its meta sidecar conflict on every merge — regenerate, never hand-merge.** Git will
  auto-merge a 5 MB generated JSON *without conflict markers*; that is not evidence it is right.
- **Use the Edit tool for anything containing backticks or backslashes.** Heredocs and `node -e` mangled
  the same edit three times.
- **Check `$?` on every `bsc plan change` write.** A failed `change note` writes nothing while the commit
  still lands, so the slice looks finished and the record is simply absent.

---

## After the defect is fixed — the next batch, ranked by leverage

The census's **blocker ranking is the work queue**, not diagnostic output. One 59-line module
(`SettingsControls`) unblocked 14 — nearly as many files as harvesting 39 cards one at a time.

```bash
node scripts/promote-records.mjs --store <(bsc ui list --full) --impls <(bsc graph impl list) \
  | grep "unresolvable import" | sed 's/.*needs //' | tr ',' '\n' | sort | uniq -c | sort -rn
```

Current top, with sizes:

| module | lines | blocks |
|---|---|---|
| `shared/lib/session/roleModel` | 534 | 4 |
| `features/settings` (barrel) | — | 3 |
| `features/planner/lib/plannerCore/hash` | **25** | 3 |
| `shared/lib/algorithms/windowedTally` | 86 | 2 |

**Permanently blocked — do not re-attempt:** `previewBundle` (174 lines) and `blueprintBuiltins` (110)
both use `import.meta.glob`, which esbuild emits verbatim and is not a function at runtime. The **6
modules behind them are permanently blocked too**, not queued. `d3-force`, `acorn`, `@xterm/xterm` are
third-party. The reachable set is smaller than the raw `unresolvable` count suggests.

Remaining backlog: ~147 with no record · 77 diverged (need per-module adjudication of which side is
truth) · 61 unresolvable · 16 unclosed-composes · 11 permanently ineligible.

---

## Housekeeping

- Two stashes on `develop`, both self-described as superseded (`partial triaged_at fix`,
  `stale main-tree react-ui.json`). Left alone — dropping a stash is unrecoverable.
- `wt-cat` holds the unmerged slice. `wt-doc`, `wt-focus` are parked; `wt-glance` is another session's.
- `npm run worktrees:cap` reclaims parked trees; a full gate is ~8 GB, so only **two** fit concurrently
  (`BSC_GATE_SLOTS`).
- `LogsViewerCard` has a pre-existing `\x1b` escape in JSX-text position, flagged by the store validator
  when its record was authored. Renders as literal backslash-text. Not fixed.
