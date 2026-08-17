// Hard-link byte-identical dependency artifacts across worktrees
// (#identical-dependency-artifacts-are-duplicated-per-worktree).
//
//   node scripts/dedupe-deps.mjs [--dry-run] [--min-age-mins N]
//
//     --dry-run          report what would be linked, change nothing
//     --min-age-mins N   skip files modified within N minutes (default 60)
//
// MEASURED: 721 of 765 rlibs in one worktree's `deps/` share a filename with another's, and sampled
// pairs are byte-identical — 3.6 GB per tree of the same bytes, ~25 GB across the current pool.
//
// The selection lives in the pure `dedupe-plan.mjs`; this file does the hashing and linking.
//
// ## EXPLICIT, like the worktree cap — never wired into the gate or build:plan
//
// The sweeps run automatically because their worst outcome is a rebuild. This rewrites files that
// several trees share. It is verified-safe, but it is not the kind of thing that should happen
// because someone ran a gate.
//
// ## Why this is safe, and where the residual risk actually is
//
// Dependencies carry `debug = false` (the #795 linker-OOM fix), so no absolute paths are baked in,
// and a shared filename already implies shared inputs because `-C metadata` folds package + features
// + profile + target. Sampled pairs hash-matched. Even so, **every group is sha256-verified before
// any link is made** — a filename is a hint, never a proof.
//
// The residual risk is narrow and was weighed openly: rustc does not obviously write outputs
// atomically, so a build in one tree could briefly expose a partially-written file to the others.
// That surfaces as a LOUD link error which the next build resolves, not as silent corruption — an
// earlier draft of this overstated it as a lurking trap, and that was wrong. `--min-age-mins` keeps
// a live build from being raced at all.
//
// FAIL-SAFE: any single group that errors is skipped and reported; one bad file cannot abort the run
// or leave a tree without its artifact, because the link is only made after the copy is verified.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planDedupe, reclaimableBytes } from "./dedupe-plan.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const i = argv.indexOf("--min-age-mins");
  const n = i === -1 ? NaN : Number(argv[i + 1]);
  return {
    dryRun: argv.includes("--dry-run"),
    minAgeMs: (Number.isFinite(n) && n >= 0 ? n : 60) * 60_000,
  };
}

/** Every checkout git knows about, main tree included. */
function trees() {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/** Workspace package names in the underscored form cargo uses in artifact filenames. */
function workspaceCrates() {
  const meta = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  );
  return new Set(meta.packages.map((p) => p.name.replace(/-/g, "_")));
}

function depsFiles(tree) {
  const dir = join(tree, "target", "debug", "deps");
  const found = [];
  let listing;
  try {
    listing = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found; // tree has no build output
  }
  for (const entry of listing) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    try {
      const s = statSync(path);
      found.push({ tree, path, name: entry.name, size: s.size, mtimeMs: s.mtimeMs, ino: s.ino });
    } catch {
      // vanished mid-scan
    }
  }
  return found;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Replace `target` with a hard link to `source`, via a temp rename so an interrupted run can never
 *  leave the tree WITHOUT the artifact. The original is only unlinked once the link exists. */
function relink(source, target) {
  const backup = `${target}.dedupe-bak`;
  renameSync(target, backup);
  try {
    linkSync(source, target);
  } catch (e) {
    renameSync(backup, target); // put it back exactly as it was
    throw e;
  }
  unlinkSync(backup);
}

/**
 * Push the shared inode's mtime to the newest in its group.
 *
 * WITHOUT THIS, DEDUP COSTS A FULL REBUILD PER TREE AND UNDOES ITSELF. Hard links share metadata, so
 * a linked artifact adopts the CANONICAL copy's mtime — which in every non-canonical tree reads as an
 * output older than cargo recorded, so cargo rebuilds it. Measured on the first real run: 189 and 190
 * crates recompiled (~150s each) in the two non-canonical trees, while the canonical tree recompiled
 * 0. Those rebuilds then write fresh artifacts and break the links, so the reclaimed space comes back.
 *
 * Cargo's staleness test is directional — it rebuilds when an output is OLDER than expected, never
 * when it is newer. So moving the single shared inode to the group's NEWEST mtime satisfies every
 * tree at once, and is the one metadata change a shared inode permits.
 */
function syncMtime(path, mtimeMs) {
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = trees().flatMap(depsFiles);
  const groups = planDedupe(all, { workspaceCrates: workspaceCrates(), minAgeMs: opts.minAgeMs });

  let linked = 0;
  let bytes = 0;
  let mismatched = 0;
  let failed = 0;

  for (const group of groups) {
    const [canonical, ...rest] = group.files;
    let newest = canonical.mtimeMs;
    let want;
    try {
      want = sha256(canonical.path);
    } catch {
      failed += 1;
      continue;
    }
    for (const dup of rest) {
      try {
        // THE GUARD: identical name and size is a hint; only the hash authorizes a link.
        if (sha256(dup.path) !== want) {
          mismatched += 1;
          continue;
        }
        if (!opts.dryRun) relink(canonical.path, dup.path);
        linked += 1;
        bytes += group.size;
        newest = Math.max(newest, dup.mtimeMs);
      } catch (e) {
        failed += 1;
        console.warn(`[dedupe] skipped ${dup.path}: ${(e?.message ?? e).toString().split("\n")[0]}`);
      }
    }
    // One shared inode now backs every copy, so give it the group's NEWEST mtime — otherwise every
    // non-canonical tree reads its artifact as stale and rebuilds. See syncMtime.
    if (!opts.dryRun && newest > canonical.mtimeMs) {
      try {
        syncMtime(canonical.path, newest);
      } catch {
        // best-effort: the worst case is exactly the rebuild this avoids
      }
    }
  }

  const gb = (bytes / 1073741824).toFixed(2);
  const verb = opts.dryRun ? "would link" : "linked";
  console.log(
    `[dedupe] ${verb} ${linked} file(s), ~${gb} GB reclaimed ` +
      `(${groups.length} candidate group(s), ~${(reclaimableBytes(groups) / 1073741824).toFixed(2)} GB eligible` +
      `${mismatched ? `, ${mismatched} hash mismatch` : ""}${failed ? `, ${failed} skipped` : ""})`
  );
}

main();
