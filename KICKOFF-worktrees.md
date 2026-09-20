# Kickoff — resolve the 19 remaining worktrees to zero

## The task

Nineteen git worktrees hold commits that are not on `develop`. Work through them one at a time:
**land what is real, delete what is superseded.** Finish with every one either merged into local
`develop` or removed, and the branch deleted in both cases.

This is a salvage review, not a merge queue. Roughly half of these hold a genuine unlanded fix and
half are drafts that were superseded by a better version that already landed. The whole job is
telling those apart, per branch, with evidence.

## State as of 2026-08-28

- `develop` is checked out in **`wt-integrate/`**. Do all merging there. The main checkout at the
  repo root is on `main` and other sessions move it — never assume where `develop` lives, run
  `git worktree list` and confirm.
- 27 worktrees, 46 branches, repo at ~297 GB.
- **`wt-169` and `wt-busy` hold uncommitted work belonging to other live sessions. Do not touch
  them.** They have no unmerged commits, so they are not on the list below, but they will show up
  in `git worktree list`.
- Other sessions land branches while you work. Two of mine (`108`, `130`) landed mid-review. Re-check
  `git merge-base --is-ancestor` before acting on anything, not just at the start.

## The nineteen, largest first

```
28G    wt-149      the-graph-rail-is-not-selectable-either
20G    wt-cred     a-credentials-workspace-shows-the-state-of-every-credential
19G    wt-req142   request-142-wake-precheck-admits-recoverable-gate
16G    wt-stamp    algorithm-writes-are-stamped-and-refuse-a-stale-overwrite
13G    wt-floor    165-fleet-wake-mints-a-missing-build-tab
8.0G   wt-sigkill  a-caged-session-is-sigkilled-ten-seconds-in
7.7G   126-graph-hosted-page-preview-stale-message-race
7.6G   request-116-ui-seed-promote
7.5G   109-ui-test-adopt
6.7G   request-113-srctext-refs
6.5G   123-tests-harvest-seed-sync
6.2G   wt-xgraph   store-the-three-cross-pillar-edges
6.0G   request-125-no-implementation-provides  (branch: request-125-graph-provides-no-implementation)
5.0G   request-95-usage-index-sources
5.0G   114-doctor-category-filter
3.2G   wt-142-fleet-wake  142-fleet-wake-provisions-gate
2.0G   wt-161      161-session-ask-wait-implies-on-busy-wait
163M   request-142-fleet-wake-settings
45M    wt-131      131-starter-kit-glob-shim
```

All nineteen were clean (no uncommitted changes) at handoff. Re-verify before removing any of them —
another session may have started using one.

`request-116-ui-seed-promote` is **partly diagnosed**: develop already has a `promote` in
`crates/bsc-component/src/cli.rs`, but **118 of the branch's 239 code lines are absent** from it.
That one needs the diff read, not a verdict from the count.

`wt-req142`, `wt-142-fleet-wake` and `request-142-fleet-wake-settings` are three branches around the
same request — check them together, they may be successive drafts of one change.

## The method that works

Per branch:

1. **Confirm it is genuinely ahead**, and re-confirm at the moment you act:
   ```bash
   git rev-list --count develop..<branch>
   git merge-base --is-ancestor <branch> develop && echo "ALREADY LANDED"
   ```

2. **Measure how much of it is absent from develop** — this is the cheap triage signal:
   ```bash
   git diff develop...<branch> -- <path> | grep -E '^\+' | grep -v '^+++' \
     | while IFS= read -r l; do t="${l#+}"; case "$(echo "$t"|sed 's/^ *//')" in ''|//*|/\*\**) continue;; esac
         grep -qF -- "$t" <path> || echo "$t"; done
   ```
   Near-zero absent ⇒ superseded, delete. Substantially absent ⇒ read the diff and decide.

3. **Read the diff.** There is no shortcut past this for anything with real absent lines. Decide
   whether the capability is genuinely missing from develop or merely spelled differently.

4. **If it lands:** merge in `wt-integrate`, gate, stamp. **If it does not:** remove worktree,
   delete branch.

## False oracles — every one of these lied to me this session

- **Name greps.** Three false negatives (`openNetworkArchitect`,
  `a_cwd_outside_a_project_names_every_explicit_route`, and one more). A capability lands under a
  different name constantly. **Search for the behaviour and the code, not the identifier.**
- **`git cherry develop <branch>`.** Reports all nineteen as `+N -0`. That is true by patch-id and
  still useless — it called branch `122` new when develop already carried a reworked, better version.
  Patch-id is a lower bound on "already landed", never a proof of "not landed".
- **`grep` in this repo is a shell function wrapping ugrep with `--ignore-files`**, and
  `.bsc-records/` is gitignored, so recursive greps silently skip the emitted record mirror. Pass
  `--no-ignore-files` when the answer might live there.
- **The staged `bsc` binary predates recent merges.** Probing it gave me four false "capability
  absent" readings. Rebuild, or read the source. Always include a control case whose answer you
  already know — that is the only reason I caught it.
- **`git branch -d` checks the current HEAD, not `develop`.** It failed silently on branches that
  were merged. Always gate a delete on
  `git merge-base --is-ancestor <branch> develop` explicitly.
- **awk over `git worktree list --porcelain`** silently no-ops if you match the wrong field, and then
  reports removals that never happened. The working form matches `$2` against `refs/heads/<branch>`
  inside the `/^branch /` block.

## Rules that are not negotiable

- **Never push. Never write to GitHub.** No `git push`, no `gh issue create/close/edit`, no
  `gh pr create/merge`. Reads are fine. Integration is a local `git merge --no-ff` into `develop`.
- **Never `&&`-chain a merge with its plan stamps.** I did this twice: the merge conflicted and the
  stamps recorded success anyway. Merge, verify with `git merge-base --is-ancestor`, *then* stamp.
- **The gate must be redirected to a file and its `$?` read.**
  ```bash
  npm run gate -- --full > "$TMPDIR/gate.log" 2>&1; echo "exit=$?"; tail -40 "$TMPDIR/gate.log"
  ```
  Piping into `tail` reports `tail`'s status and a failing gate looks green. A full gate is an ~8 GB
  operation and takes a cross-worktree lock slot — do not run two.
- **Anything that lands needs a `bsc plan` item and a `bsc plan change` record**, with honest gate
  evidence including skipped and failed steps.
  ```bash
  export BSC_PLAN_DB="$HOME/.base-studio-code/plans/studio-code.db"
  ```
  **Check the exit status of every `change` write** — a failed `change note` writes nothing while the
  commit still lands, so the slice looks finished and the record is simply gone.
- **Single-quote `bsc` note text.** Backticks get eaten by shell substitution and notes are
  append-only, so the loss is permanent.
- **A throwaway script is a missing `bsc` command** — file `bsc request new "<what you needed>"
  --cmd "<the command>" --from <you>` instead of writing it. Read-only grep/jq pipelines and tests
  are exempt.
- **Recycle worktrees, don't recreate them** — `cd wt-<short> && git checkout -B <ref> develop`
  keeps the warm `target/` (0.41s vs 1m59s). `bsc disk worktree cap` (formerly `npm run worktrees:cap`, since moved onto the `bsc` surface) is destructive and refuses
  dirty trees on purpose; that refusal has already saved real staged work once.

## Done means

Zero worktrees holding unmerged commits, apart from `wt-169` and `wt-busy`. Every branch either
merged into local `develop` with a change record, or deleted with a one-line reason recorded for why
it was superseded.
