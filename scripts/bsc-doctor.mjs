#!/usr/bin/env node
/**
 * `npm run bsc:doctor` — can I trust the `bsc` I am about to run?
 *
 * Three failure modes, all of which have cost real time in this repo, and none of which the binary can
 * report about itself:
 *
 *  * **zero-byte** — a broken link. Through bash it exits 0 printing nothing, which reads as success.
 *  * **incoherent** — it runs but cannot identify itself. `bsc-plan-read-verbs-return-nothing-on-a-current-build`
 *    records an hour lost to a build where every `plan` verb exited 0 with empty output.
 *  * **stale** — older than the source, so `unknown command` means "not built", not "removed".
 *    `the-installed-bsc-binary-silently-reverts-to-an-old-build` cost three false regression reports.
 *
 * Exit codes are the point of the tool: NON-ZERO when no usable binary exists, 0 when one does — a
 * merely stale binary WARNS rather than failing, so this is safe to run anywhere, including a gate.
 */
import { execFileSync } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { candidatePaths, inspect, freshness, humanizeMs } from "./lib/bscBinary.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");

const statSize = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
};
const mtime = (p) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Run `<bsc> version` and capture it. A hang is as bad as a wrong answer here, so the call is bounded —
 * this runs inside a gate, and a wedged binary must not take the gate with it.
 */
const run = (p) => {
  try {
    const stdout = execFileSync(p, ["version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? "") };
  }
};

/** Newest mtime under the Rust source roots — what a binary has to be newer than to be current. */
export function newestSourceMtime(roots, { readdir, mtimeOf }) {
  let newest = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdir(dir);
    } catch {
      return; // an absent root is not an error: this runs in worktrees with different shapes
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name === "target" || e.name === "node_modules" || e.name === ".git") continue;
        walk(full);
      } else if (e.name.endsWith(".rs")) {
        const m = mtimeOf(full);
        if (m !== null && (newest === null || m > newest)) newest = m;
      }
    }
  };
  for (const r of roots) walk(r);
  return newest;
}

if (process.argv[1]?.endsWith("bsc-doctor.mjs")) {
  const readdir = (d) =>
    readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  const newest = newestSourceMtime([join(ROOT, "crates"), join(ROOT, "src-tauri", "src")], {
    readdir,
    mtimeOf: mtime,
  });

  const results = candidatePaths(ROOT, homedir(), join).map((p) => {
    const r = inspect(p, { statSize, run });
    return { ...r, fresh: freshness(mtime(p), newest) };
  });

  let firstUsable = null;
  process.stdout.write("\nbsc binaries\n");
  for (const r of results) {
    if (r.ok && !firstUsable) firstUsable = r;
    const mark = r.ok ? "ok  " : "FAIL";
    process.stdout.write(`  [${mark}] ${r.path}\n`);
    if (r.ok) {
      process.stdout.write(`         ${r.version}   ${(r.size / 1e6).toFixed(1)} MB\n`);
      if (r.fresh.known && r.fresh.stale) {
        process.stdout.write(
          `         STALE — ${humanizeMs(r.fresh.behindMs)} older than the newest .rs change. ` +
            "`unknown command` from this binary means NOT BUILT, not removed.\n",
        );
      }
    } else {
      process.stdout.write(`         ${r.state}: ${r.detail}\n`);
    }
  }

  if (!firstUsable) {
    process.stdout.write("\nNo usable bsc. Build one: cargo build -p bsc --bin bsc\n");
    process.exit(1);
  }
  process.stdout.write(`\nusing: ${firstUsable.path}\n`);
  process.exit(0);
}
