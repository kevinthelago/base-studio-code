// Promote `develop` into `main` AT THE REPO ROOT — the tree the app runs from — explicitly, never on
// your behalf.
// (#the-app-runs-from-its-own-tree-so-a-merge-never-restarts-it)
//
//   node scripts/promote-app.mjs [--dry-run] [--skip-gate] [--tree wt-app]
//
// ## The problem this closes
//
// `tauri dev` runs from a checkout, and that checkout used to be the SAME one every `git merge --no-ff`
// lands in. So integrating work restarted the app under whoever was using it — and the person doing the
// integrating is the person being interrupted. MEASURED across one session's five merges: 4 of 5 wrote
// files under `src/`, `src-tauri/src/` or `crates/` (4, 2, 1, 0 and 7 watched files), every one of which
// rebuilds and relaunches.
//
// Narrowing a watcher cannot fix that: those are real source changes the watcher is RIGHT to notice.
// The fix is that the app does not run from the tree you merge into.
//
// THE ROOT IS THE APP'S TREE, and integration moved out. The root checks out `main` and is where
// `npm run dev:app` runs; a worktree checks out `develop` and is where every branch merges. That
// direction was chosen over parking the app in `wt-app` because the root is where a person expects to
// find the application, and the surprise belongs on the transient activity (integrating) rather than
// on the persistent one (running the thing you are building).
//
// Note what this needs and does not need: merging `develop` into `main` here requires only the
// `develop` REF, not its checkout. So this script never has to know where the integration tree is.
//
// Two things this deliberately does NOT do:
//
//   - **It never restarts the app BEHIND YOUR BACK.** A promote writes working-tree files that
//     `tauri dev` and vite are watching, so if the app is running it WILL rebuild and relaunch — that
//     is inherent, because new Rust means a new binary. What this buys is that it happens when YOU ran
//     the command, not when someone else merged. The script says so up front and names the app if it
//     can see it running, rather than claiming a restart will not happen.
//   - **It never merges non-fast-forward.** The running app must be a PREFIX of develop's history, not
//     a divergent branch. If it cannot fast-forward, something committed directly to `main` and that is
//     a fault to look at, not to paper over with a merge commit.

import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";
import { classifyGateFailure, gateTreeMoved, planPromote, treeMovedMessage } from "./promote-plan.mjs";

/** The MAIN worktree, not whichever worktree this script happens to be running from.
 *
 *  Deriving the root from `import.meta.url` is wrong here and the bug is invisible until you run it
 *  from a worktree: `wt-resume/scripts/promote-app.mjs` resolved `wt-resume/wt-app`, reported "no app
 *  worktree" and offered to create a nested one. `--git-common-dir` is the shared `.git` every worktree
 *  points at, so its parent is the one main checkout wherever you are standing. */
function mainWorktree(from) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: from,
    encoding: "utf8",
  }).trim();
  return dirname(common);
}

/** The branch the repo root is expected to hold — the app's tree (see the header). Named once so the
 *  guard, the refusal text and the distance report cannot disagree about which ref they mean. */
const APP_BRANCH = "main";

/** The dedicated, detached worktree the gate runs in — see [`gateTree`].
 *
 *  DOT-PREFIXED, and not `wt-promote-gate`, because `wt-*` is this repo's convention for a WORK tree
 *  and a detached one with no branch reads as free. MEASURED on the first real run: another session
 *  claimed it mid-gate and checked develop's newer tip out from under the gate, which the moved-check
 *  then correctly refused — the guard worked, the address was wrong. A dotted name is not the shape
 *  anybody's "find a spare worktree" habit reaches for. */
const GATE_TREE = ".promote-gate";

const REPO_ROOT = mainWorktree(dirname(dirname(fileURLToPath(import.meta.url))));

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts }).trim();
}

/** Is a dev server running FOR THIS TREE?
 *
 *  Two signals, because either alone lies — the same lesson `gate-tree-guard` records in its own
 *  header: **the port is MACHINE-GLOBAL**. A listener on 1420 says only that SOME worktree has a dev
 *  server up, and the first version of this check reported "the app is RUNNING" off that alone while
 *  the Tauri shell was not running at all. So: find the listener's pid, then ask whether its working
 *  directory is this tree. A pid we cannot inspect degrades to "cannot tell", which prints the
 *  conservative message rather than a confident wrong one.
 */
function appIsRunning(port = 1420) {
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const line = out.split(/\r?\n/).find((l) => new RegExp(`[.:]${port}\\s`).test(l));
    if (!line) return false;
    const pid = line.match(/pid=(\d+)/)?.[1];
    if (!pid) return false;
    // Exactly this tree. A dev server in a WORKTREE has that worktree as its cwd, so an equality
    // test is both the simplest and the correct one — a prefix match would claim every worktree's
    // server as ours, which is the machine-global mistake one layer down.
    return readlinkSync(`/proc/${pid}/cwd`) === REPO_ROOT;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    skipGate: argv.includes("--skip-gate"),
  };
}

function fail(msg) {
  console.error(`[promote-app] ${msg}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  // TRACKED modifications only — see planPromote. `--untracked-files=no` is the whole fix for the
  // class of noise that made this refuse over stray root dotfiles.
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean);
  const behind = branch !== "HEAD" ? Number(git(["rev-list", "--count", `${branch}..develop`])) : 0;
  const ahead = branch !== "HEAD" ? Number(git(["rev-list", "--count", `develop..${branch}`])) : 0;

  // The two facts that separate a bookkeeping divergence from a real one (see `planPromote`). Both are
  // asked of git rather than inferred: how many ahead commits carry CONTENT (a merge commit carries
  // none of its own), and whether the two trees are byte-identical.
  const aheadContent =
    branch !== "HEAD" && ahead > 0
      ? Number(git(["rev-list", "--count", "--no-merges", `develop..${branch}`]))
      : 0;
  const aheadAddsNothing = branch !== "HEAD" && ahead > 0 ? addsNothingBeyondMergeBase(branch, "develop") : false;

  // How far the APP branch actually is from develop — asked of the ref, not of the checkout, so the
  // refusal below can answer the question the caller came with even while the root is on something else.
  const appBehind = Number(git(["rev-list", "--count", `${APP_BRANCH}..develop`]) || "0");

  const { action, reason } = planPromote({
    treeExists: true, branch, dirty, ahead, behind, aheadContent, aheadAddsNothing, appBranch: APP_BRANCH,
  });
  if (action === "fail") {
    const why = {
      "detached-head": `the repo root is in detached HEAD; check out the app branch (${APP_BRANCH}) first.`,
      "wrong-app-branch":
        `the repo root is on '${branch}', not the app branch '${APP_BRANCH}'.\n` +
        `  Promoting would fast-forward '${branch}' and leave '${APP_BRANCH}' where it is —\n` +
        `  which is ${appBehind} commit(s) behind develop right now, the thing you actually asked about.\n` +
        `  The root is the APP's tree and belongs on '${APP_BRANCH}'; work branches belong in a wt-* worktree.\n` +
        `  If '${branch}' is real work, move it: git checkout ${APP_BRANCH} (the branch ref is kept).`,
      "dirty-app-tree":
        "the repo root has uncommitted changes — refusing to promote over them:\n" +
        dirty.map((l) => `    ${l}`).join("\n"),
      "app-tree-ahead":
        `${branch} is ${ahead} commit(s) AHEAD of develop — it has history develop does not.\n` +
        `  A fast-forward is impossible, which means something committed straight to ${branch}.\n` +
        `  Look at it (git log develop..${branch}) rather than merging around it.`,
    }[reason];
    fail(why ?? reason);
  }
  if (action === "reconcile") {
    // THE DOOM-LOOP REPAIR. The app ref's unique commits are all merges, and it adds nothing beyond
    // where the two diverged — so merging it back into develop changes no file, and afterwards the
    // app ref is an ANCESTOR of develop, which is exactly the property `--ff-only` promotion needs.
    // The loop cannot restart from here.
    //
    // ANNOUNCED, NEVER SILENT. It moves a ref the caller did not name, which is the kind of
    // helpfulness that has to be visible — and the count is the interesting part, because it says
    // how long the loop had been running before anyone noticed.
    console.log(
      `[promote-app] ${branch} is ${ahead} commit(s) ahead of develop, and EVERY one is a merge\n` +
        `  commit adding nothing beyond where the two diverged. That is the residue of promoting by\n` +
        `  hand with --no-ff, where each merge makes the next --ff-only impossible.`,
    );
    if (opts.dryRun) {
      console.log(
        `[promote-app] --dry-run: would merge ${branch} back into develop (no content change), so that\n` +
          `  fast-forward promotion works again.`,
      );
      return;
    }
    const tree = integrationTree();
    if (tree === REPO_ROOT) {
      // `integrationTree` falls back to the root when it cannot find develop's checkout. That
      // fallback is harmless for the GATE (it costs a refusal from `gate-tree-guard`) but not here:
      // this merge would run in the APP's tree, on the app's branch, which is the one place this
      // whole script exists to leave alone.
      fail(
        "cannot reconcile: no worktree has `develop` checked out, so there is nowhere to merge into.\n" +
          "  Check out develop somewhere (the convention is wt-integrate) and re-run.",
      );
    }
    // Plain `merge`, not `--ff-only`: when develop has not moved this IS a fast-forward and git does
    // it without writing anything, and when develop HAS moved it writes one merge commit that changes
    // no file. Either way the app ref becomes an ancestor of develop, which is the property
    // `--ff-only` promotion needs. Demanding a fast-forward here would refuse the second case, which
    // is the common one.
    execFileSync("git", ["merge", branch, "-m", `merge: ${branch} into develop — reconcile the promote bookkeeping`], {
      cwd: tree,
      stdio: "inherit",
    });
    console.log(`[promote-app] reconciled: ${branch} merged back into develop. Fast-forward promotion works again.`);
    // Fall through deliberately rather than returning: develop may ALSO have been ahead in the normal
    // direction, and re-asking git is how this stays correct instead of assuming which case it was.
    const nowBehind = Number(git(["rev-list", "--count", `${branch}..develop`]));
    if (nowBehind === 0) {
      console.log(`[promote-app] ${branch} already matches develop — nothing further to promote.`);
      return;
    }
  }

  if (action === "noop") {
    console.log(`[promote-app] ${branch} already matches develop — nothing to promote.`);
    return;
  }

  const toPromote = Number(git(["rev-list", "--count", `${branch}..develop`]));
  console.log(`[promote-app] ${branch} is ${toPromote} commit(s) behind develop:`);
  console.log(
    git(["log", "--oneline", "--no-decorate", `${branch}..develop`])
      .split("\n")
      .slice(0, 12)
      .map((l) => `    ${l}`)
      .join("\n"),
  );

  // THE COMMIT THIS PROMOTE IS ABOUT, pinned before anything is verified.
  //
  // Everything below gates and fast-forwards to THIS sha, never to `develop` as it stands later. The
  // gate used to run in the SHARED integration tree and then fast-forward to whatever develop had
  // become — so a fleet that integrates every few minutes invalidated a 4-minute gate almost every
  // time. MEASURED 2026-09-01: three consecutive promotes each gated CLEAN and each was refused for
  // "HEAD moved while it ran", and `main` drifted from 8 commits behind to 22 during the attempts.
  //
  // The refusal was right — if HEAD moves mid-gate the compiler and the test runner read files ACROSS
  // the change, so the state actually compiled is a mixture that exists in no commit, whether or not
  // both endpoints are clean. Cleanliness at the end says nothing about what was read in the middle,
  // which is why narrowing the check to "moved vs half-merged" is unsound and was rejected.
  const pinned = git(["rev-parse", "develop"]);

  if (!opts.skipGate) {
    console.log(`[promote-app] running the FULL gate on develop@${pinned.slice(0, 9)} before promoting…`);
    const tree = gateTree(pinned);
    const startedAt = Date.now();
    // Still read either side — see `gateTreeMoved`. In a tree nobody else writes to this is now an
    // INVARIANT rather than a coin flip, and if it ever fires it means something genuinely unexpected
    // touched the gate tree rather than "the fleet was busy".
    const headBefore = headOf(tree);
    let gateFailed = false;
    try {
      // In the INTEGRATION tree, never here: `gate-tree-guard` refuses to run a second cargo over the
      // target/ that `tauri dev` owns, and after the inversion that target/ is this one.
      execFileSync("npm", ["run", "gate", "--", "--full"], { cwd: tree, stdio: "inherit" });
    } catch {
      gateFailed = true;
    }

    // ASKED BEFORE THE VERDICT IS READ, and before a known-red declaration gets a chance to speak for
    // it. A declaration explains a leg that genuinely failed; it cannot explain a result that is not
    // about this tree. Order matters here, and it is the whole reason this is not folded into
    // `classifyGateFailure`.
    const moved = gateTreeMoved(headBefore, headOf(tree));
    if (moved.moved) {
      fail(treeMovedMessage(moved, tree));
    }

    if (gateFailed) {
      // A red leg somebody has ACCOUNTED FOR should not force the whole verification to be skipped —
      // see `classifyGateFailure`. Every other outcome refuses exactly as it did before.
      const verdict = classifyGateFailure(gateVerdict(tree), declaredKnownRed(), startedAt);
      if (!verdict.proceed) {
        fail(gateRefusal(verdict));
      }
      console.log(`[promote-app] the gate FAILED, and every red leg is a DECLARED known-red:`);
      for (const { key, ref } of verdict.explained) {
        console.log(`    ${key}  — owned by ${ref}`);
      }
      console.log(
        `[promote-app] 0 unexplained. Promoting on that declaration — develop WAS verified, and the\n` +
          `  leg(s) above stay red and stay owned. This is not --skip-gate: an undeclared red still refuses.`,
      );
    }
  } else {
    console.log(`[promote-app] --skip-gate: promoting WITHOUT verifying develop.`);
  }

  if (opts.dryRun) {
    console.log(`[promote-app] --dry-run: would fast-forward ${branch} to develop@${pinned.slice(0, 9)}.`);
    return;
  }

  // BSC_PROMOTE is the ONE sanctioned hole in the ref guard (scripts/guard-policy.mjs): moving the
  // app's ref is refused everywhere else, so this announces itself explicitly rather than being
  // sniffed for.
  // TO THE PINNED SHA, not to `develop`. develop may well have moved during the gate — that is normal
  // and fine — but what was verified is this commit, so this is what lands. Anything newer waits for
  // the next promote, which is the honest trade: `main` moves to something that was actually gated.
  git(["merge", "--ff-only", pinned], { env: { ...process.env, BSC_PROMOTE: "1" } });
  console.log(`[promote-app] ${branch} → ${git(["rev-parse", "--short", branch])}`);
  console.log(
    appIsRunning()
      ? `[promote-app] A dev server for THIS tree is up — it is rebuilding and will relaunch now.`
      : `[promote-app] No dev server for this tree; the app picks this up on its next launch.`,
  );
}

/** Does `ref` add any content beyond where it diverged from `other`?
 *
 *  Asked of git rather than inferred from the commit graph: "every ahead commit is a merge" says those
 *  commits carry no content of their OWN, but a merge can still resolve to a tree the merge base did
 *  not have (a conflict resolved by hand, an `--ours`). Reconciling on the weaker signal alone would
 *  merge over that resolution and lose it silently.
 *
 *  AGAINST THE MERGE BASE, not against `other`'s current tree. Comparing the two refs answers "are
 *  these identical right now", which stops being true the moment `other` moves ahead — after any
 *  integration, i.e. before every real promotion. This asks only what `ref` contributed, so it holds
 *  however far develop has travelled since. */
function addsNothingBeyondMergeBase(ref, other) {
  try {
    const base = execFileSync("git", ["merge-base", ref, other], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    execFileSync("git", ["diff", "--quiet", base, ref], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Where `develop` is checked out — the integration tree. Only the GATE needs it; the merge itself
 *  needs just the ref. Falls back to the root, which is wrong but only costs a refusal from
 *  `gate-tree-guard` rather than a corrupt build. */
function integrationTree() {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  let path = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === "branch refs/heads/develop" && path) return path;
  }
  return REPO_ROOT;
}

/** A worktree holding EXACTLY `sha`, that no other session writes to — where the gate can run without
 *  the ground moving under it.
 *
 *  WHY NOT `wt-integrate`, which is where this used to gate. That is the ONE tree every session merges
 *  into, so a 4-minute gate there is racing every integration on the box; measured cadence was a merge
 *  every 2-8 minutes, which made a clean promote a coin flip. Nothing about promoting NEEDS that tree —
 *  merging develop into main takes only the ref, as this file's header says. It was borrowed purely
 *  because `gate-tree-guard` refuses a second cargo over the root's `target/`, and any other worktree
 *  satisfies that just as well.
 *
 *  DETACHED at `sha` on purpose: this tree holds no branch, so it can never be mistaken for somewhere
 *  work belongs, and checking out a sha cannot disturb a ref another session is using.
 *
 *  IT IS CREATED ON FIRST USE AND KEPT, and the first use is EXPENSIVE. MEASURED end to end: 1179s
 *  (19.7 min) for a promote whose gate tree had no `target/`, against roughly 4 min warm. That is a
 *  cold build of the whole workspace plus the full gate, not the "couple of minutes" a `cargo build`
 *  intuition suggests — nextest alone links ~41 test binaries. So NEVER `git worktree remove` this
 *  directory to tidy up: the next promote then pays the 20 minutes again. `npm run worktrees:cap`
 *  does not touch it (it caps `wt-*`), which is a second reason the name is dotted.
 *
 *  Refuses a dirty gate tree rather than gating over somebody's edits — if that fires, something is
 *  using this directory for work, which it is not for. */
function gateTree(sha) {
  const path = join(REPO_ROOT, GATE_TREE);
  const exists = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .some((l) => l === `worktree ${path}`);
  if (!exists) {
    console.log(
      `[promote-app] creating the gate worktree ${GATE_TREE}. FIRST USE IS SLOW — it builds its own\n` +
        `  target/ from cold, measured at 19.7 min end to end against ~4 min once warm. It is kept\n` +
        `  between promotes for exactly that reason; do not delete it to tidy up.`,
    );
    execFileSync("git", ["worktree", "add", "--detach", path, sha], { cwd: REPO_ROOT, stdio: "inherit" });
    return path;
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: path, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (dirty.length) {
    fail(
      `the gate worktree ${GATE_TREE} has uncommitted changes, so gating there would verify something\n` +
        `  other than develop@${sha.slice(0, 9)}:\n` +
        dirty.map((l) => `    ${l}`).join("\n") +
        `\n  It exists only to run the gate. Clean it, or remove it with \`git worktree remove ${GATE_TREE}\`.`,
    );
  }
  execFileSync("git", ["checkout", "--detach", sha], { cwd: path, stdio: "ignore" });
  return path;
}

/** HEAD of `tree`, or null when it cannot be read — which `gateTreeMoved` treats as moved. */
function headOf(tree) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/** Why a failed gate is not promotable, said in the caller's terms. */
function gateRefusal(verdict) {
  const base = "the gate FAILED — develop is not promotable. Nothing was moved.";
  const why = {
    "no-verdict":
      "\n  The gate wrote no readable verdict at target/gate-result.json, so which legs were red is\n" +
      "  unknown. An absent verdict reads as ABSENT, never as a pass.",
    "stale-verdict":
      "\n  The verdict at target/gate-result.json predates this run, so it describes a DIFFERENT gate.\n" +
      "  A stale artifact is worse than none, because it looks authoritative.",
    "failed-outside-the-legs":
      "\n  The gate failed with no red leg — something failed around them (gate-tree-guard, a crash, a\n" +
      "  lock). A known-red declaration is about a leg and cannot speak for that.",
    "unexplained-red": `\n  Unexplained red leg(s): ${verdict.unexplained.join(", ")}.\n` +
      "  Declare one with `bsc work known-red add <leg> --ref <plan-ref>` only if an item genuinely\n" +
      "  owns it — a declaration explains a failure, it never launders one.",
  }[verdict.reason];
  return base + (why ?? "");
}

/** The gate's own verdict artifact from the tree it ran in, or null when it cannot be read. */
function gateVerdict(tree) {
  try {
    return JSON.parse(readFileSync(join(tree, "target", "gate-result.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The declared known-red legs, from the SAME store `bsc work gate` reads — never a second list here.
 *
 *  An unreadable store degrades to "nothing is declared", which refuses the promote. That is the safe
 *  direction: a missing `bsc` must not become a reason to promote an unverified develop. */
function declaredKnownRed() {
  try {
    const bsc = pickUsable(candidatePaths(REPO_ROOT, homedir(), join), {
      statSize: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return null;
        }
      },
      run: (p) => {
        try {
          return { status: 0, stdout: execFileSync(p, ["version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) };
        } catch (err) {
          return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
        }
      },
    });
    if (!bsc) return {};
    return JSON.parse(execFileSync(bsc.path, ["work", "known-red", "list", "--json"], { encoding: "utf8", timeout: 20_000 }));
  } catch {
    return {};
  }
}

main();
