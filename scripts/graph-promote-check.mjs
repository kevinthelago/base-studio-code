#!/usr/bin/env node
/**
 * `node scripts/graph-promote-check.mjs` — the gate's half of the repo-store seam.
 *
 * Under files-to-zero the build compiles from `graph/algorithms.json`, a COMMITTED file, while authoring
 * happens in the per-user runtime store. `bsc graph promote` moves records across, and that seam has a
 * drift surface by construction: an author can edit a record and never promote it, leaving the thing the
 * compiler reads silently behind the thing the author believes is current. This is the check for it.
 *
 * # Why this exits 0 when it cannot check
 *
 * Two cases are NOT failures, and conflating either with a red node would make the gate lie:
 *
 *  * **No `bsc` binary.** A fresh clone has not built one yet. The check is infrastructure; its absence
 *    is reported loudly on stdout and the gate moves on. (A compile failure is never treated this way —
 *    see the sweep, which fails hard.)
 *  * **No runtime store.** A machine that never authored these records has no opinion about whether the
 *    committed ones are stale. `bsc graph promote --check` already returns `checked: 0` there; this
 *    wrapper just does not invent a failure around it.
 *
 * What DOES fail: a record that exists in both stores and differs. That is an edit which never reached
 * the compiler, and the underlying verb names the ids.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const EXE = process.platform === "win32" ? "bsc.exe" : "bsc";

/** Where a built or staged `bsc` may live, most-local first. */
export function candidatePaths(root, home) {
  return [
    join(root, "target", "debug", EXE),
    join(root, "target", "release", EXE),
    join(home, ".base-studio-code", "bin", EXE),
  ];
}

/**
 * The first candidate that exists AND is non-empty.
 *
 * The size check is not defensive padding: a 0-byte `bsc.exe` was found in a worktree during this very
 * slice — a broken/interrupted link leaves the file in place — and every command run against it exited
 * 0 with no output, which reads exactly like "the check passed". A gate must not be satisfied by that.
 */
export function resolveBsc(paths, statSize) {
  for (const p of paths) {
    const size = statSize(p);
    if (size > 0) return p;
  }
  return null;
}

if (process.argv[1]?.endsWith("graph-promote-check.mjs")) {
  const { statSync } = await import("node:fs");
  const size = (p) => {
    try {
      return existsSync(p) ? statSync(p).size : 0;
    } catch {
      return 0;
    }
  };
  const bsc = resolveBsc(candidatePaths(ROOT, homedir()), size);
  if (!bsc) {
    process.stdout.write(
      "graph: no usable `bsc` binary (target/{debug,release} or ~/.base-studio-code/bin) — " +
        "repo-store drift NOT checked. Build one with `cargo build -p bsc --bin bsc`.\n",
    );
    process.exit(0);
  }
  try {
    const out = execFileSync(bsc, ["graph", "promote", "--check", "--root", ROOT], { encoding: "utf8" });
    process.stdout.write(out.trim() ? `${out.trim()}\n` : "graph: repo store is current\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(String(err.stdout ?? ""));
    process.stderr.write(String(err.stderr ?? ""));
    process.exit(1);
  }
}
