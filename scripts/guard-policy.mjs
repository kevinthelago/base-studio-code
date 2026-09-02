// Pure policy for the ref guard that protects the tree the app RUNS from
// (#nothing-stops-an-agent-merging-into-the-running-app).
//
// Side-effect-free and import-free, like `gate-lock-plan.mjs` beside it,
// so every refusal is unit-testable without git (`scripts/guard-policy.test.ts`).
//
// ## Why a hook and not a document
//
// The convention — the root runs the app, `wt-integrate` takes the merges — was landed in CLAUDE.md
// and the debugger charter. It did not hold. MEASURED on 2026-08-29, `refs/heads/main` moved EIGHT
// times in 90 minutes, including a non-fast-forward merge straight into it at 11:02 that no version
// of the docs has ever permitted, and a fast-forward at 11:48 that rebuilt the app under the
// maintainer mid-session.
//
// Two reasons a document could not have stopped either:
//
//   - **CLAUDE.md is PER-BRANCH.** 16 of 23 worktrees were on branches cut before the change, so a
//     session restarted in any of them reads the OLD workflow and does exactly the old thing.
//   - **A long-running session loaded its instructions before the change existed.** Nothing re-reads
//     them.
//
// `.git/hooks` lives in the COMMON dir, so one hook set governs every worktree whatever branch it is
// on and whenever its session started. That is the whole reason this is enforceable and prose is not.

/** Refs that name the running app. Moving one changes what the maintainer is looking at. */
export const APP_REFS = new Set(["refs/heads/main"]);

/**
 * Should this ref update be allowed?
 *
 * @param {{ref: string, viaPromote: boolean, cwd?: string, repoRoot?: string}} update
 * @returns {{allow: boolean, reason: string}}
 */
export function judgeRefUpdate(update) {
  const { ref, viaPromote = false, cwd, repoRoot } = update ?? {};
  if (!ref) return { allow: true, reason: "no-ref" };

  // The ONLY protected thing: the ref the app runs from. Everything else — develop, work branches,
  // tags, stashes — is untouched, because narrowing the guard to exactly the harm keeps it from
  // becoming something people disable.
  if (!APP_REFS.has(ref)) return { allow: true, reason: "not-an-app-ref" };

  // `npm run promote` is the sanctioned path: it gates develop first, refuses a dirty tree, and is
  // fast-forward only. It announces itself with an env marker rather than being sniffed for, so the
  // guard has one explicit hole instead of a heuristic.
  if (viaPromote) return { allow: true, reason: "promote" };

  // A worktree OTHER than the root may hold `main` transiently (a checkout, a bisect). Only the root
  // is the running app, so only there is a move actually disruptive.
  if (cwd && repoRoot && cwd !== repoRoot) return { allow: true, reason: "not-the-app-tree" };

  return { allow: false, reason: "app-ref-moved-outside-promote" };
}

/** What to print when a move is refused — it must say the alternative, not just "no". */
export function refusalMessage(ref) {
  return [
    `[bsc-guard] REFUSED: ${ref} is the ref the app RUNS from, at the repo root.`,
    ``,
    `  Moving it rebuilds and relaunches the app under whoever is using it — which is the`,
    `  interruption the wt-integrate split exists to prevent.`,
    ``,
    `  Integrate here instead:   cd wt-integrate && git merge --no-ff <ref>`,
    `  Update the app when YOU choose:   npm run promote`,
    ``,
    `  If you genuinely mean to move it by hand: BSC_PROMOTE=1 git ...`,
  ].join("\n");
}
