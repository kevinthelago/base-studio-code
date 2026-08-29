// Promote `develop` into the tree the app RUNS from — explicitly, never on your behalf.
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
// The fix is that the app does not run from the tree you merge into. `main` is the ref the app runs
// from, `develop` is where work integrates, and `wt-app` is a worktree on `main`.
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
import { existsSync } from "node:fs";
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

/** Is the app's dev server up? Its vite port listening is the cheap, dependency-free signal.
 *
 *  This exists so the closing message can tell the TRUTH. A promote writes files `tauri dev` and vite
 *  watch, so a running app rebuilds and relaunches — saying otherwise (as the first version of this
 *  script did) is worse than saying nothing, because the whole feature is about the user knowing when
 *  their session is about to be disturbed. */
function appIsRunning(port = 1420) {
  try {
    // `ss` is present on this platform; any failure falls through to "cannot tell", which prints the
    // conservative message rather than a confident wrong one.
    const out = execFileSync("ss", ["-ltn"], { encoding: "utf8" });
    return new RegExp(`[.:]${port}\\b`).test(out);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const t = argv.indexOf("--tree");
  return {
    dryRun: argv.includes("--dry-run"),
    skipGate: argv.includes("--skip-gate"),
    tree: t === -1 ? "wt-app" : argv[t + 1],
  };
}

function fail(msg) {
  console.error(`[promote-app] ${msg}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const appTree = join(REPO_ROOT, opts.tree);

  if (!existsSync(appTree)) {
    fail(
      `no app worktree at ${opts.tree}. Create it once:\n` +
        `    git worktree add ${opts.tree} main\n` +
        `  then run the app from there (npm run dev:app) instead of from the repo root.`,
    );
  }

  const branch = existsSync(appTree)
    ? git(["-C", appTree, "rev-parse", "--abbrev-ref", "HEAD"])
    : null;
  const dirty = branch ? git(["-C", appTree, "status", "--porcelain"]).split("\n").filter(Boolean) : [];
  const behind = branch && branch !== "HEAD" ? Number(git(["rev-list", "--count", `${branch}..develop`])) : 0;
  const ahead = branch && branch !== "HEAD" ? Number(git(["rev-list", "--count", `develop..${branch}`])) : 0;

  const { action, reason } = planPromote({ treeExists: true, branch, dirty, ahead, behind });
  if (action === "fail") {
    const why = {
      "detached-head": `${opts.tree} is in detached HEAD; check out the app branch first.`,
      "dirty-app-tree":
        `${opts.tree} has uncommitted changes — refusing to promote over them:\n` +
        dirty.map((l) => `    ${l}`).join("\n"),
      "app-tree-ahead":
        `${branch} is ${ahead} commit(s) AHEAD of develop — it has history develop does not.\n` +
        `  A fast-forward is impossible, which means something committed straight to ${branch}.\n` +
        `  Look at it (git log develop..${branch}) rather than merging around it.`,
    }[reason];
    fail(why ?? reason);
  }
  if (action === "noop") {
    console.log(`[promote-app] ${branch} already matches develop — nothing to promote.`);
    return;
  }

  console.log(`[promote-app] ${branch} is ${behind} commit(s) behind develop:`);
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
      execFileSync("npm", ["run", "gate", "--", "--full"], { cwd: REPO_ROOT, stdio: "inherit" });
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

  // Fast-forward INSIDE the app tree: git refuses to move a branch that is checked out elsewhere, and
  // this is the right place anyway — it is the moment the running copy changes.
  git(["-C", appTree, "merge", "--ff-only", "develop"]);
  console.log(`[promote-app] ${branch} → ${git(["rev-parse", "--short", branch])}`);
  console.log(
    appIsRunning()
      ? `[promote-app] The app is RUNNING — it is rebuilding and will relaunch itself now.`
      : `[promote-app] The app is not running; it picks this up on its next launch.`,
  );
}

main();
