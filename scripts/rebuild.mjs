/**
 * Rebuild and relaunch the whole app, from cold. One command, for when you are not sure what is stale.
 *
 *   npm run rebuild
 *
 * ## Why this exists
 *
 * `npm run build` does NOT update the running app, and that is the trap this script exists to close.
 * It runs `tsc && vite build`, which writes `dist/` — and `dist/` is only read by `tauri build` (the
 * installer), never by `tauri dev`. The dev app serves its frontend from the vite dev server on
 * :1420 (`devUrl` in tauri.conf.json). So `npm run build` can succeed every time and change nothing
 * you can see.
 *
 * ## What updates what, normally
 *
 *   src/**              vite HMR — instant, no command at all
 *   src-tauri/data/**   the seed records; needs `emit-records` (this script, or an app restart)
 *   src-tauri/src/**    `tauri dev` watches Rust and rebuilds + restarts the app itself
 *   crates/**           `npm run build:plan`, then RESTART the app so the sidecar is re-staged
 *
 * In the normal case `npm run dev:app` already does all of that — its `beforeDevCommand` is
 * `build:plan && emit-records && vite`, and tauri builds the app binary itself. This script is for
 * the case where something is actually wedged: a stale record tree, a 0-byte binary from a killed
 * build, a sidecar that never got re-staged.
 *
 * ## What it deliberately does NOT do
 *
 * `cargo clean`. That discards ~20 GB and costs a full cold rebuild (measured elsewhere in this repo
 * at ~2 minutes for the binaries alone, far longer for the app). Nothing here needs it: the record
 * tree is regenerated from the seed, and `verify-build-artifacts` already heals a truncated artifact.
 * If you genuinely need it, run it yourself and know what you are paying.
 */
import { spawnSync, spawn } from "node:child_process";
import { rmSync, existsSync, statSync, unlinkSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(process.env.HOME ?? REPO, ".base-studio-code", "dev-app.log");

const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`);
const ok = (msg) => console.log(`      ✓ ${msg}`);

/** The process command lines this script is allowed to kill, for a repo at `repo`.
 *  ABSOLUTE paths only, never a bare name: `pkill -f base-studio-code` would match the developer's
 *  editor, a grep for the string, and this very script. Exported so the rule is testable without
 *  spawning anything. */
export function killPatterns(repo) {
  return [`${repo}/target/debug/base-studio-code`, `${repo}/node_modules/.bin/tauri`];
}

/** Should `cmd` be killed? A command line matches only by containing one of the absolute paths. */
export function shouldKill(cmd, repo) {
  return killPatterns(repo).some((p) => cmd.includes(p));
}

/** Stop a running dev app. Matched on the exact binary path and the tauri CLI, never a bare name —
 *  a loose pattern here would kill the developer's editor or this very script. */
function stopRunningApp() {
  const patterns = killPatterns(REPO);
  let killed = 0;
  const ps = spawnSync("ps", ["-eo", "pid,cmd", "--no-headers"], { encoding: "utf8" });
  for (const line of (ps.stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, cmd] = m;
    if (Number(pid) === process.pid) continue;
    if (!patterns.some((p) => cmd.includes(p))) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
      killed++;
    } catch {
      // Already gone between the listing and the signal — nothing to do.
    }
  }
  return killed;
}

/** Remove a build artifact that exists but is empty — what a killed or OOM-ed link leaves behind.
 *  Cargo will not rebuild it on its own: its fingerprint says the unit is current, so a plain rebuild
 *  reports `Finished` and leaves the 0-byte file exactly where it was. Removing it is what makes
 *  cargo disagree with its own fingerprint. */
function dropTruncatedBinaries() {
  const dropped = [];
  for (const bin of ["bsc", "bsc-agent", "bsc-hook", "base-studio-code"]) {
    const p = join(REPO, "target", "debug", bin);
    if (existsSync(p) && statSync(p).size === 0) {
      unlinkSync(p);
      dropped.push(bin);
    }
  }
  return dropped;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`\n✗ \`${cmd} ${args.join(" ")}\` failed (exit ${r.status}).`);
    console.error("  This is a real build error — the rebuild stopped here rather than launching a stale app.");
    process.exit(r.status ?? 1);
  }
}

/** The rebuild itself. Behind a main guard so importing this module — which the test does, to
 *  reach the pure matcher above — does NOT stop the developer's app and rebuild their repo. */
function main() {
  console.log("Rebuilding base-studio-code from cold.");

  step(1, "Stopping any running app…");
  const killed = stopRunningApp();
  ok(killed ? `stopped ${killed} process(es)` : "nothing was running");

  step(2, "Clearing the emitted record tree…");
  // ~1,000 frontend modules ship as RECORDS and are materialized here from the seed. A stale tree is
  // the most common reason a seed edit does not reach the screen. Regenerated in step 4.
  rmSync(join(REPO, ".bsc-records"), { recursive: true, force: true });
  ok("removed .bsc-records/ — it regenerates from the seed");

  step(3, "Dropping any truncated binaries…");
  const dropped = dropTruncatedBinaries();
  ok(dropped.length ? `removed empty: ${dropped.join(", ")}` : "none were truncated");

  step(4, "Building the sidecars (bsc, bsc-agent, bsc-hook)…");
  run("npm", ["run", "build:plan"]);
  ok("sidecars built, verified and staged");

  step(5, "Launching the app (this also builds the app binary + re-emits records)…");
  // Detached on purpose: the app must outlive this script and whatever shell started it, so closing
  // the terminal — or an agent session ending — does not take the app down with it.
  const fd = openSync(LOG, "a");
  const child = spawn("npm", ["run", "dev:app"], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);

  console.log(`      ✓ started (pid ${child.pid}), detached from this terminal`);
  console.log(`\nThe window takes ~30-60s to appear while Rust builds.`);
  console.log(`Watch it:   tail -f ${LOG}`);
  console.log(`Stop it:    npm run rebuild   (it stops the old one first)  — or close the window.`);
}

// Run only when invoked directly (`npm run rebuild`), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
