# Kickoff — graph migration, local-first

Paste this as the opening message of the next session.

---

You are continuing the **graph-is-the-app migration** on `base-studio-code`. Read `CLAUDE.md` first — its
*Development Workflow* section overrides the global one. This document is the state of play, not a spec.

## Hard rules — read before doing anything

**GitHub stays silent. This is not a preference.**

- **No `git push`.** Ever. Branches are local; the remote drifts behind on purpose.
- **No `gh` writes** — no `gh issue create/close/edit`, no `gh pr create/merge`, no label or milestone
  writes. `gh` *reads* (`gh issue list`, `gh api` GET) are fine; they are how a future sync learns about drift.
- **No GitHub issue numbers for new work.** Work is tracked in `plan.db`. A ref like `4260-…` on an
  existing item is *provenance*, not a link to act on.
- If something genuinely needs to reach GitHub, that is the maintainer's decision, not a step in the loop.

**Do not run `npm test` or `cargo test` as a routine gate.** The standing instruction. Two exceptions have
been earned, and both should be argued out loud when used:
- a **browser check** (`npm run test:e2e -- <spec>`) when the change's correctness depends on real layout,
  the real cascade, or the real loader — jsdom structurally cannot see those;
- a **single targeted file** when the change risks destroying user data and the assertion is the only thing
  standing between the user and that loss.

**Never commit on `develop` or `main`.** Work in a worktree at the repo root (`wt-<short>`), merge locally
with `git merge --no-ff`. Verify the merge landed *before* deleting anything — never `&&`-chain a merge
with a branch delete.

## The surface

```bash
export BSC_PLAN_DB="$HOME/.base-studio-code/plans/base-studio-code.db"   # THIS repo's own board
BSC=./target/debug/bsc.exe        # rebuild: cargo build -p bsc --bin bsc  (unset CARGO_TARGET_DIR in a worktree)

$BSC plan list --status open      # 93 open
$BSC plan get <ref>               # acceptance criteria — read BEFORE writing code
$BSC plan status <ref> in_progress|complete      # complete ≠ verified; you do not verify your own work

$BSC plan change new <ref> --note "<title>" --description "<what and why>"
$BSC plan change note <ref> "<work note>" --from claude    # append-only, WHILE the reasoning is live
$BSC plan change gate <ref> typecheck pass                 # record what the gate ACTUALLY observed
$BSC plan change status <ref> merged --command <merge-sha>
$BSC plan change render <ref>     # markdown → PR body when synced · CHANGELOG entry at release
```

`bsc plan change` is the local PR (added this session). Use it for every slice — the notes are the reason
the next session knows *why*, and gate results are what make "complete" a claim with evidence behind it.

**Gate before committing** (worktrees are zero-install if nested under the repo root):

```bash
npm run typecheck      # must be clean
npm run lint           # 0 errors
cargo check -p <crate> && cargo clippy -p <crate> --all-targets -- -D warnings   # if Rust changed
```

## Where the migration stands

The app renders from graph **records**, with registered code as a fallback. 383 packaged records; **44
already have no file at all** — the model demonstrably works. The other 339 are alive because
`appModules.ts` (117 static imports) and `registry.tsx` statically pull them into the bundle *as the
fallback*. **That is what keeps every migrated file on disk**, and no amount of further migrating deletes a
file until it changes.

Landed this session: a **module system** (records link once and are resolved by a Node-style `require`,
instead of being re-bundled into every ancestor on every mount), a **link verifier** + browser sweep over
all ~383 records, local **change records**, four dead page copies removed from feature barrels, and an
automatic **provenance repair** on hydrate.

### The three things in front of file deletion

1. **`record-src-reconcile`** (P1) — ~44 records whose `src` names a missing file, plus ~66 whose record
   content no longer matches the file it points at. **The file was the newer copy in nine of nine cases
   #4235 checked**, so deleting these silently reverts real work. Hard prerequisite. Note: **#4223 shipped
   the detector, not the fix** — do not read its changelog entry as "done".
2. **`record-link-debt`** (P1) — 14 records import modules registered nowhere. `platformBoundary.test.ts`
   is **already red on `develop`** with the same list, and with CI disabled nothing was reporting it. Six
   are a registration fix; `@/components/teams-agent-face` names a record that does not exist and needs a
   decision instead. `e2e/recordLinks.spec.ts` carries them as a ratcheted list that may only shrink.
3. **The code-fallback decision** — *the maintainer's call, not yours.* Give up the registered-code
   fallback, or keep it and accept that files stay? Everything downstream waits on this. The argument for
   giving it up: the drift class (#4223, #4235) exists **only** because two copies exist.

### Not ticketed, deliberately — raise before starting

- **The write-time block.** `record-link-verifier` shipped a *verifier*, not a block. A real block needs
  `setComponent` to become async (compilation is) and needs an answer for `bsc ui set` — the designer's
  actual authoring path, a Rust CLI with no compiler in it. A frontend-only block misses the main writer.
- **Global module identity.** The module system's evaluated-exports cache is deliberately **per load**, so
  instance semantics match the old vendoring exactly. Making it global is what would let `stageScreens`
  migrate — a real improvement, and an identity change that must not hide inside a performance change.
- **The `skills` barrel** — last of five; 394 lines, 4 test files to relocate. Recipe proven four times.
- **`planner-github-sync-rescope`** (P2) — those four items were written for a world we left; half shipped
  locally and the rest assumes issues-only sync. Re-scope before anyone picks one up.

Once the fallback goes, **49 files / ~7,300 lines** come out in a 6-wave cascade, with 59 unmigrated
components, 11 feature barrels and 7 shell files behind them.

## Conventions that bite

- **A graph record DEFINES its workspace symbol; it never imports it.** Trimming a feature barrel is safe —
  but verify per feature, because `typecheck` cannot see it (`graphPlatform` namespace-imports the barrel,
  so a record importing a removed export fails only at runtime).
- **`HooksView` has zero file importers and is load-bearing** — the `automationspage` *record* imports it
  through the graph platform. A file-import search calls it dead. It is not.
- **`shadowPages` declares each file baseline twice** — the module entry *and* the raw glob — and a test
  pins both directions. Retiring a page copy is two edits.
- **A store-only write to a *seeded* record is transient** — the next `reconcileSeed` drops it. Write to the
  seed.
- Records carry **absolute** specifiers. A relative one can never be reached by `provides`.

## Suggested opening move

Start with **`record-link-debt`**: it is real breakage, it is bounded, and finishing it empties the ratchet
list and turns `platformBoundary` green — which is a guard the repo currently has in name only.

Ask the maintainer about the fallback decision early; it changes what everything else is for.
