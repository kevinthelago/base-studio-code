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
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");

if (process.argv[1]?.endsWith("graph-promote-check.mjs")) {
  // Resolution is SHARED with `bsc-doctor` (scripts/lib/bscBinary.mjs) rather than duplicated: a second
  // copy of "is this binary usable" is exactly how one of them ends up not knowing about the zero-byte
  // case. `pickUsable` demands a real handshake, not mere existence.
  const statSize = (p) => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  };
  const run = (p) => {
    try {
      return { status: 0, stdout: execFileSync(p, ["version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) {
      return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
    }
  };

  const usable = pickUsable(candidatePaths(ROOT, homedir(), join), { statSize, run });
  if (!usable) {
    process.stdout.write(
      "graph: no usable `bsc` binary — repo-store drift NOT checked. " +
        "Run `npm run bsc:doctor` to see why, then `cargo build -p bsc --bin bsc`.\n",
    );
    process.exit(0);
  }
  try {
    const out = execFileSync(usable.path, ["graph", "promote", "--check", "--root", ROOT], { encoding: "utf8" });
    process.stdout.write(out.trim() ? `${out.trim()}\n` : "graph: repo store is current\n");
    process.exit(0);
  } catch (err) {
    process.stdout.write(String(err.stdout ?? ""));
    process.stderr.write(String(err.stderr ?? ""));
    process.exit(1);
  }
}
