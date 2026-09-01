// Pure decision logic for promoting `develop` into the tree the app RUNS from
// (#the-app-runs-from-its-own-tree-so-a-merge-never-restarts-it).
//
// Side-effect-free and import-free, like `worktree-pool-plan.mjs` beside it, so every refusal is
// unit-testable without git or a filesystem (`scripts/promote-plan.test.ts`).
//
// Each refusal below exists because the alternative is worse than stopping, and the whole point of the
// feature is that the user's session is never disturbed by surprise.

/**
 * Decide what a promote run should do.
 *
 * `aheadContent` and `aheadAddsNothing` are what separate a REAL divergence from BOOKKEEPING — see the
 * `ahead > 0` arm. Both default to the pessimistic answer, so a caller that cannot supply them gets
 * exactly the old refusal rather than an accidental reconcile.
 *
 * @param {{treeExists: boolean, branch: string|null, dirty: string[], ahead: number, behind: number,
 *          aheadContent?: number, aheadAddsNothing?: boolean}} state
 * @returns {{action: "fail"|"noop"|"promote"|"reconcile", reason: string}}
 */
export function planPromote(state) {
  const {
    treeExists,
    branch,
    dirty = [],
    ahead = 0,
    behind = 0,
    // How many of the ahead commits carry CONTENT (i.e. are not merges). Defaulting to `ahead`
    // means "assume every one is real", which is the old behaviour exactly.
    aheadContent = ahead,
    // Does the app ref add any CONTENT beyond the merge base — i.e. `git diff <merge-base> <app ref>`
    // is empty? See the `ahead > 0` arm for why this, and not a whole-tree comparison against
    // develop's current state.
    aheadAddsNothing = false,
    // The branch the APP's tree is expected to be on. `null` opts out (the `--tree`/testing path),
    // which is why this is a stated field rather than a hardcoded "main" inside the check.
    appBranch = "main",
  } = state ?? {};

  if (!treeExists) {
    return { action: "fail", reason: "no-app-tree" };
  }
  // A detached HEAD has no branch to fast-forward, and guessing which ref was meant is exactly the
  // kind of helpfulness that moves the running app somewhere nobody chose.
  if (!branch || branch === "HEAD") {
    return { action: "fail", reason: "detached-head" };
  }
  // THE ROOT IS ON SOME OTHER BRANCH, so "promote" would fast-forward the wrong ref and say nothing.
  //
  // Every other guard here exists for the case where this script's central assumption fails — a
  // detached HEAD, a dirty tree, a ref ahead of develop — and each one explains what it found. The one
  // assumption never checked was the one the script is NAMED for: that the root is on the APP branch.
  //
  // MEASURED 2026-09-01: someone had run `git checkout -B <work-ref> develop` at the repo ROOT, which
  // the convention forbids precisely because the root is the app's tree. `branch` was therefore a work
  // branch already sitting at develop's tip, so `behind` was 0 and the script reported "already matches
  // develop — nothing to promote" and exited 0. `main` was five commits back and nobody was told.
  //
  // That failure is SILENT and GREEN, which is worse than any of the ones this does catch. Reading
  // main's position needs only the ref, not a checkout, so the check costs nothing.
  if (appBranch && branch !== appBranch) {
    return { action: "fail", reason: "wrong-app-branch" };
  }
  // Someone edited the RUNNING copy. `dirty` is deliberately TRACKED modifications only: a
  // fast-forward cannot destroy an untracked file — git leaves it alone, and at worst refuses the
  // merge itself with "untracked working tree file would be overwritten", which is a clearer error
  // than anything this could invent. Counting untracked files here made every promote refuse over
  // 0-byte editor/shell dotfiles that a tooling sandbox materialises at the repo root.
  if (dirty.length > 0) {
    return { action: "fail", reason: "dirty-app-tree" };
  }
  // The app ref holds history develop does not, so a fast-forward is impossible.
  //
  // THERE ARE TWO WAYS TO GET HERE AND THEY WANT OPPOSITE ANSWERS. Measured 2026-08-30: `main` was 17
  // commits ahead, every single one a MERGE commit titled "merge: develop into main", and the trees
  // were byte-identical. Nothing had been committed straight to main — the refusal's own accusation
  // was false, and it sent the reader at `git log develop..main` for a fault that was not there.
  //
  // It is a doom loop, not a one-off: a hand-run `git merge --no-ff develop` puts a commit on main
  // that develop lacks, which makes the NEXT `--ff-only` impossible, which forces the next promotion
  // to be done by hand too. Seventeen times. The guard was firing on a condition its own workflow
  // created. (The script has never produced this state: `--ff-only` moves the ref and writes no
  // commit at all.)
  //
  // So split the case on evidence rather than weakening the guard:
  //
  //   BOOKKEEPING — no ahead commit carries content, AND the app ref adds nothing beyond the MERGE
  //   BASE. Its unique commits are then merges that only re-state history develop already has, so
  //   merging it back into develop changes no file, and afterwards the app ref is an ancestor of
  //   develop and `--ff-only` works again. Provable from git, which is what makes it safe to automate
  //   rather than a judgement call.
  //
  //   REAL — anything else. A content commit on the app ref, or a merge that resolved to a tree the
  //   merge base did not have, is the fault this refusal was written for, and it still refuses with
  //   the same reason. The guard is not relaxed here; it is made precise, so from now on it only
  //   fires when it is telling the truth.
  //
  // THE COMPARISON IS AGAINST THE MERGE BASE, NOT AGAINST DEVELOP'S CURRENT TREE, and the first
  // implementation got this wrong in a way a single snapshot could not reveal. Comparing the two
  // ref trees answers "are these identical right now", which stops being true the instant develop
  // moves ahead — that is, after any integration at all, which is every real promotion. It fired
  // only in the one state where develop had not moved since the last promote, and refused in exactly
  // the state the feature exists for. Asking what the app ref ADDED is stable under develop moving,
  // because it asks about the app ref alone.
  if (ahead > 0) {
    if (aheadContent === 0 && aheadAddsNothing) {
      return { action: "reconcile", reason: "app-tree-ahead-by-merges-only" };
    }
    return { action: "fail", reason: "app-tree-ahead" };
  }
  if (behind === 0) {
    return { action: "noop", reason: "already-current" };
  }
  return { action: "promote", reason: "behind" };
}

/** Precedence is deliberate and pinned by tests: a dirty tree is reported even when it is also ahead,
 *  because the uncommitted work is the thing at risk and the thing the user can still lose. */
export const REFUSAL_ORDER = ["no-app-tree", "detached-head", "dirty-app-tree", "app-tree-ahead"];

/**
 * Can a FAILED gate still be promoted through, because every red leg is a DECLARED known-red?
 *
 * `bsc work gate` already models this: a declaration explains a failure, the exit code follows
 * UNEXPLAINED reds, and the recorded result of a red leg stays `fail` regardless. `npm run promote`
 * had no such vocabulary, so one stale data file left exactly two options — refuse the promote, or
 * `--skip-gate`, which skips verifying develop ENTIRELY. MEASURED 2026-09-01: `graph-promote-check`
 * was red all day with a rotating node while the other legs were green (4127 tests), so every promote
 * that day was an unverified one. That is a real safety cost paid daily for one stale record.
 *
 * This closes the gap in the same shape and with the same refusals:
 *
 *  - **An absent verdict reads as ABSENT, never as a pass.** No artifact, unparseable, or no `legs`
 *    array ⇒ `no-verdict`, and the promote refuses exactly as before.
 *  - **A STALE artifact is worse than none**, because it looks authoritative. The verdict must be
 *    from the run that just failed, so it must have finished at or after this run started.
 *  - **A gate that failed with no red leg is never excused.** Something failed outside the legs —
 *    `gate-tree-guard`, a crash, a lock — and a declaration about a leg cannot speak for it.
 *  - A declaration NEVER launders the red. The caller announces each explained leg and its owning
 *    item; this only decides whether the run may continue.
 *
 * @param {{finishedAt?: string, legs?: {key: string, ok: boolean}[]}|null} result
 * @param {Record<string, {ref?: string}>} knownRed
 * @param {number} startedAtMs when this promote started the gate
 */
export function classifyGateFailure(result, knownRed, startedAtMs) {
  if (!result || !Array.isArray(result.legs)) {
    return { proceed: false, reason: "no-verdict", explained: [], unexplained: [] };
  }
  const finished = Date.parse(result.finishedAt ?? "");
  if (!Number.isFinite(finished) || finished < startedAtMs) {
    return { proceed: false, reason: "stale-verdict", explained: [], unexplained: [] };
  }
  const red = result.legs.filter((l) => !l.ok);
  if (red.length === 0) {
    return { proceed: false, reason: "failed-outside-the-legs", explained: [], unexplained: [] };
  }
  const explained = [];
  const unexplained = [];
  for (const leg of red) {
    const ref = knownRed?.[leg.key]?.ref;
    if (ref) explained.push({ key: leg.key, ref });
    else unexplained.push(leg.key);
  }
  return {
    proceed: unexplained.length === 0,
    reason: unexplained.length === 0 ? "all-red-legs-declared" : "unexplained-red",
    explained,
    unexplained,
  };
}

/**
 * Is the gate's verdict about the tree it claims to be about?
 *
 * `npm run promote` gates in `wt-integrate`, which is the ONE shared tree every session merges into.
 * `bsc plan integrate` takes a named lock so two MERGES cannot race (#185), and the full gate takes a
 * slot so two GATES cannot exhaust memory — but neither lock is held against the other, so a merge and
 * a gate in the same tree proceed simultaneously. The gate slot bounds memory, not tree stability.
 *
 * MEASURED 2026-09-01 ~10:59, which is why this exists rather than being a precaution. A promote gate
 * compiled a transient half-merged state and reported:
 *
 *     nextest  FAIL (1.6s)
 *     error: this file contains an unclosed delimiter --> crates/bsc-shot/src/lib.rs:640:49
 *
 * A file, a line, a syntax error — and entirely false. That file's brace balance is 0 at every commit
 * that ever touched it, and a re-gate minutes later passed 4127 tests. A false red here is
 * indistinguishable from a real one at the exact moment someone is deciding whether develop is safe to
 * ship, and both honest responses are bad: believe it and refuse a good promote, or learn to discount it
 * and eventually skip past a real break.
 *
 * THIS CHECKS BOTH DIRECTIONS, not only the red one the incident produced. A PASS over a half-merged
 * tree is the more dangerous outcome, because it promotes on a verification of a state that never
 * existed in history and nobody will ever see again. A verdict from a moved tree is not a lenient
 * verdict or a harsh one — it is not a verdict.
 *
 * `null`/unknown on either side means the HEAD could not be read, and that is treated as MOVED. A check
 * that cannot see the tree must not certify it; the cost is a re-run and the alternative is the silent
 * false confidence this whole item is about.
 *
 * @param {string|null} before HEAD of the integration tree before the gate ran
 * @param {string|null} after  HEAD of the same tree after it finished
 */
export function gateTreeMoved(before, after) {
  if (!before || !after) return { moved: true, reason: "head-unreadable" };
  if (before !== after) return { moved: true, reason: "head-moved", before, after };
  return { moved: false, reason: "head-stable" };
}

/** What to tell the caller when the tree moved under the gate. */
export function treeMovedMessage(state, treePath) {
  const where = treePath ? ` in ${treePath}` : "";
  if (state.reason === "head-unreadable") {
    return (
      `the gate ran, but this could not read HEAD${where} before and after it, so there is no way to\n` +
      `  know whether the tree it compiled is the tree you are promoting. Treating that as UNTRUSTWORTHY\n` +
      `  rather than as a pass. Nothing was moved — re-run the promote.`
    );
  }
  return (
    `the gate's verdict is UNTRUSTWORTHY: HEAD${where} moved while it ran\n` +
    `    ${state.before} → ${state.after}\n` +
    `  Another session merged into the shared integration tree mid-gate, so the gate compiled a\n` +
    `  transient half-merged state that exists in no commit. Its result — pass OR fail — is about a tree\n` +
    `  nobody has. Nothing was moved; re-run the promote now that the merge has landed.`
  );
}
