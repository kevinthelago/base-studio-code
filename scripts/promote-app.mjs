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
import { existsSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planPromote } from "./promote-plan.mjs";

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

  const { action, reason } = planPromote({ treeExists: true, branch, dirty, ahead, behind, aheadContent, aheadAddsNothing });
  if (action === "fail") {
    const why = {
      "detached-head": "the repo root is in detached HEAD; check out the app branch (main) first.",
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

  if (!opts.skipGate) {
    console.log(`[promote-app] running the FULL gate on develop before promoting…`);
    try {
      // In the INTEGRATION tree, never here: `gate-tree-guard` refuses to run a second cargo over the
      // target/ that `tauri dev` owns, and after the inversion that target/ is this one.
      execFileSync("npm", ["run", "gate", "--", "--full"], { cwd: integrationTree(), stdio: "inherit" });
    } catch {
      fail("the gate FAILED — develop is not promotable. Nothing was moved.");
    }
  } else {
    console.log(`[promote-app] --skip-gate: promoting WITHOUT verifying develop.`);
  }

  if (opts.dryRun) {
    console.log(`[promote-app] --dry-run: would fast-forward ${branch} to develop.`);
    return;
  }

  // BSC_PROMOTE is the ONE sanctioned hole in the ref guard (scripts/guard-policy.mjs): moving the
  // app's ref is refused everywhere else, so this announces itself explicitly rather than being
  // sniffed for.
  git(["merge", "--ff-only", "develop"], { env: { ...process.env, BSC_PROMOTE: "1" } });
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

main();
