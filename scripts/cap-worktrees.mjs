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
//   - **Anything not on a `parked-*` branch**, including the main tree — excluded by construction in
//     the planner, not by a check here.
//
// A branch delete is attempted after a successful removal and its failure is non-fatal: the tree is
// already gone, and a lingering `parked-*` ref costs nothing but a line in `git branch`.

import { execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planCap } from "./worktree-pool-plan.mjs";

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

function parseArgs(argv) {
  const i = argv.indexOf("--keep");
  const n = i === -1 ? NaN : Number(argv[i + 1]);
  return {
    keep: Number.isFinite(n) && n >= 0 ? n : 2,
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
  }));
  const byName = new Map(trees.map((t) => [t.name, t]));
  const { remove, refused } = planCap(trees, { keep: opts.keep });

  for (const { name, why } of refused) {
    console.warn(`[cap-worktrees] REFUSED ${name}: ${why}`);
  }
  if (remove.length === 0) {
    console.log(`[cap-worktrees] nothing to remove (keeping the newest ${opts.keep} parked)`);
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
      // the tree is already gone; a lingering parked-* ref costs nothing
    }
  }
}

main();
