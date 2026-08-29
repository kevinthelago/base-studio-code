// Cap the PARKED worktree pool (#worktree-pool-has-no-cap-so-parked-trees-hold-160gb).
//
//   node scripts/cap-worktrees.mjs [--keep N] [--dry-run]
//
//     --keep N     parked trees to spare, most-recently-built first (default 2)
//     --dry-run    report what would go, remove nothing
//
// MEASURED 2026-08-16: twelve trees, EIGHT of them parked, each ~18-21 GB — roughly 160 GB held to
// save the ~2 minutes that recycling buys over a 1m59s cold build. Nothing inside a worktree is
// reclaimable (the deps GC measured 0 orphaned units on every one), so the only lever is how many
// exist. The selection lives in the pure `worktree-pool-plan.mjs`; this file is the git-touching half.
//
// ## DESTRUCTIVE — deliberately NOT wired into build:plan
//
// The two janitors (`prune-incremental`, `sweep-target`) run before every dev launch because their
// worst outcome is a rebuild. This one deletes a working tree and its branch. It is an explicit
// command, run when you want it, and it never runs on your behalf.
//
// ## What it refuses rather than works around
//
//   - **A junction/symlink `node_modules`.** `git worktree remove` FOLLOWS it and wipes the shared
//     root install — a hazard already recorded in CLAUDE.md. Refused outright, because the cost of
//     being wrong once is every worktree agent losing its dependencies.
//   - **Uncommitted work.** `--force` is never passed. If git declines to remove a dirty tree, that
//     refusal IS the safety feature; the failure is reported and the tree is left alone.
//   - **A ref whose work has not landed**, including the main tree — excluded by construction in the
//     planner, not by a check here. Since 2026-08-29 a MERGED branch is collectable too: the old
//     `parked-*`-only rule is why the pool reached 64 trees / 631 GB, because agents merge and stop
//     rather than parking, leaving 20 of 23 merged trees permanently invisible here.
//   - **A tree touched in the last 12 hours** (`--min-idle-hours`). Merged is not idle: a session
//     keeps working in its tree after merging, so without this the widened rule would delete a
//     working tree out from under a live agent.
//
// A branch delete is attempted after a successful removal and its failure is non-fatal: the tree is
// already gone, and a lingering `parked-*` ref costs nothing but a line in `git branch`.

import { execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { INTEGRATION_BRANCHES, planCap } from "./worktree-pool-plan.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts });
}

/** Parse `git worktree list --porcelain` into `{path, branch}` records. */
function listWorktrees() {
  const out = git(["worktree", "list", "--porcelain"]);
  const trees = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      trees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return trees;
}

/** The hazard check: a symlinked/junctioned `node_modules` makes removal destructive. */
function blockedReason(path) {
  const nm = join(path, "node_modules");
  try {
    if (lstatSync(nm).isSymbolicLink()) {
      return "node_modules is a symlink/junction — `git worktree remove` would follow it and wipe the shared install";
    }
  } catch {
    // absent — the normal, zero-install case
  }
  return null;
}

/** When this tree was last COMPILED IN — the warm target/ is the only thing a parked tree is for. */
function lastBuiltMs(path) {
  for (const probe of ["target/debug", "target"]) {
    try {
      return statSync(join(path, probe)).mtimeMs;
    } catch {
      // no target/ yet — falls through to 0, i.e. the least valuable tree to keep
    }
  }
  return 0;
}

/** Is `branch` already contained in the integration branch? Then its tree holds no unlanded work. */
function isMerged(branch) {
  if (!branch) return false; // detached HEAD — we cannot name what it holds, so never collect it
  // `develop` is its own ancestor, so without this the main tree reports as merged. The planner
  // refuses it too; both layers say so, because the cost of either one being wrong is the repo.
  if (INTEGRATION_BRANCHES.has(branch)) return false;
  try {
    git(["merge-base", "--is-ancestor", branch, "develop"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** When anyone last WORKED in this tree, as opposed to last compiled in it.
 *
 *  The worktree's private index is the cheap, reliable signal: every `git status`, `add`, `commit`
 *  and `checkout` writes it, and an agent runs those constantly. Walking the tree for the newest
 *  source mtime would be more direct and costs a full filesystem scan per tree; `target/` recency is
 *  folded in as a floor so a long compile also counts as activity. */
function lastActiveMs(path) {
  let newest = lastBuiltMs(path);
  try {
    const dotgit = readFileSync(join(path, ".git"), "utf8").trim();
    const gitdir = dotgit.startsWith("gitdir:") ? dotgit.slice("gitdir:".length).trim() : null;
    if (gitdir) newest = Math.max(newest, statSync(join(gitdir, "index")).mtimeMs);
  } catch {
    // the main tree (a .git DIRECTORY), or no index yet — the build time stands alone
  }
  return newest;
}

function parseArgs(argv) {
  const i = argv.indexOf("--keep");
  const n = i === -1 ? NaN : Number(argv[i + 1]);
  const j = argv.indexOf("--min-idle-hours");
  const h = j === -1 ? NaN : Number(argv[j + 1]);
  return {
    keep: Number.isFinite(n) && n >= 0 ? n : 2,
    minIdleMs: Number.isFinite(h) && h >= 0 ? h * 60 * 60 * 1000 : undefined,
    dryRun: argv.includes("--dry-run"),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const trees = listWorktrees().map((t) => ({
    name: t.path,
    branch: t.branch,
    blocked: blockedReason(t.path),
    lastBuiltMs: lastBuiltMs(t.path),
    lastActiveMs: lastActiveMs(t.path),
    merged: isMerged(t.branch),
    isMain: t.path === REPO_ROOT,
  }));
  const byName = new Map(trees.map((t) => [t.name, t]));
  const { remove, refused } = planCap(trees, { keep: opts.keep, minIdleMs: opts.minIdleMs });

  for (const { name, why } of refused) {
    console.warn(`[cap-worktrees] REFUSED ${name}: ${why}`);
  }
  if (remove.length === 0) {
    console.log(`[cap-worktrees] nothing to remove (keeping the newest ${opts.keep} collectable)`);
    return;
  }

  for (const path of remove) {
    const branch = byName.get(path)?.branch;
    if (opts.dryRun) {
      console.log(`[cap-worktrees] would remove ${path} (${branch})`);
      continue;
    }
    try {
      // NO --force: a dirty tree's refusal is the safety feature.
      git(["worktree", "remove", path], { stdio: "pipe" });
      console.log(`[cap-worktrees] removed ${path} (${branch})`);
    } catch (e) {
      const why = (e.stderr ?? e.message ?? "").toString().trim().split(/\r?\n/)[0];
      console.warn(`[cap-worktrees] kept ${path}: ${why}`);
      continue;
    }
    try {
      git(["branch", "-D", branch], { stdio: "pipe" });
    } catch {
      // the tree is already gone; a lingering ref costs nothing but a line in `git branch`
    }
  }
}

main();
