// Run a command under `bsc errors run` — the BOOTSTRAP, and nothing else.
//
// The recording logic is not here. It is `bsc errors run` (crates/errordb/src/run.rs), which is where a
// command surface belongs in this repo. What lives here is the one thing the binary cannot do for
// itself: FIND a trustworthy `bsc`, and get out of the way when there isn't one.
//
// That case is not hypothetical — it is the normal state on a fresh clone, where the very command being
// wrapped (`build:plan`) is what BUILDS `bsc`. A wrapper that failed there would make a clone unable to
// build itself, so the degrade is the feature: no usable binary ⇒ run the command plainly, exit with its
// code, record nothing. The failure is still on screen; it is only the durable copy that is missing, and
// it comes back on the next build.
//
//   node scripts/record-run.mjs --stage <stage> [--source <tag>] [--project <key>] -- <cmd>…
//
// `pickUsable` is the shared check from bsc-doctor, and it is doing real work: a ZERO-BYTE `bsc` (what a
// broken or interrupted link leaves) executes through bash as an empty script and exits 0 printing
// nothing, which is indistinguishable from success. Delegating to one of those would silently record
// nothing forever while looking like it worked.
import { spawnSync, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Split our flags from the child's command at the FIRST bare `--`.
 *
 * First, not last: the child may legitimately carry a `--` of its own (`npm run tauri -- dev`), and
 * splitting on the last one would hand `dev` to us and swallow the command.
 */
export function splitArgs(argv) {
  const at = argv.indexOf("--");
  if (at === -1) return { ok: false, reason: "no `--`: usage is `--stage <s> [--source <t>] -- <cmd>…`" };
  const cmd = argv.slice(at + 1);
  if (cmd.length === 0) return { ok: false, reason: "no command after `--`" };
  return { ok: true, ours: argv.slice(0, at), cmd };
}

/**
 * Does this `bsc errors help` output advertise the `run` verb?
 *
 * The probe exists because of a real smoke-test failure: the first candidate binary predated the verb,
 * so delegating printed `bsc: unknown flag '--'` and exited 1 — and the wrapped command NEVER RAN. A
 * wrapper that can stop the build it wraps is worse than no wrapper, and no exit code distinguishes
 * that from the child failing, because both are 1.
 *
 * Matched as a menu ROW (`run` at the start of a line) rather than a substring: the word appears in
 * prose all over that help text, and `.includes("run")` would call every old binary capable.
 */
export function helpAdvertisesRun(helpText) {
  return /^\s*run\s/m.test(String(helpText ?? ""));
}

/**
 * Does this binary's `errors run` help advertise `--measure-only`?
 *
 * The SAME probe as {@link helpAdvertisesRun}, for the same reason and against the same failure. A
 * binary can be new enough to have `run` and still predate this flag — the staged `bsc` in
 * `~/.base-studio-code/bin` routinely does, because it is only refreshed when the app boots. Handing
 * it `--measure-only` prints `bsc: unknown flag '--measure-only'`, exits 1, and THE WRAPPED COMMAND
 * NEVER RUNS. That is not a missing measurement, it is a broken gate: every leg would fail with a flag
 * error while the code under test was never compiled.
 *
 * So a binary that cannot measure is treated exactly like no binary at all — run the command plainly,
 * record nothing. The measurement is the optional half; the build is not.
 */
export function helpAdvertisesMeasureOnly(helpText) {
  return /--measure-only/.test(String(helpText ?? ""));
}

/** Run the command with no wrapper at all, and become its exit code. */
const plain = (cmd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: false });
  // A signal death has no code; 130 is what a shell would report for the interrupt that caused it.
  process.exit(r.status ?? 130);
};

const deps = {
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
};

const supportsMeasureOnly = (path) => {
  try {
    return helpAdvertisesMeasureOnly(
      execFileSync(path, ["errors", "run", "help"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }),
    );
  } catch {
    return false;
  }
};

const supportsRun = (path) => {
  try {
    return helpAdvertisesRun(
      execFileSync(path, ["errors", "help"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }),
    );
  } catch {
    return false;
  }
};

function main(argv) {
  const split = splitArgs(argv);
  if (!split.ok) {
    process.stderr.write(`record-run: ${split.reason}\n`);
    process.exit(2);
  }
  const { ours, cmd } = split;

  // `pickUsable` is the shared check from bsc-doctor, and it is doing real work here: a ZERO-BYTE `bsc`
  // (what a broken or interrupted link leaves — and what `target/debug/bsc` is for the seconds it is
  // being linked) executes through bash as an empty script and exits 0 printing nothing, which is
  // indistinguishable from success. Delegating to one would record nothing forever while looking fine.
  const usable = pickUsable(candidatePaths(REPO, homedir(), join), deps);
  if (!usable || !supportsRun(usable.path)) plain(cmd);
  // A binary too old for the flag we are about to pass is the same case as no binary — see
  // `helpAdvertisesMeasureOnly`. Checked only when the flag is actually being used, so an ordinary
  // wrapped build costs no extra probe.
  if (ours.includes("--measure-only") && !supportsMeasureOnly(usable.path)) plain(cmd);

  const r = spawnSync(usable.path, ["errors", "run", ...ours, "--", ...cmd], { stdio: "inherit", shell: false });
  // `bsc errors run` exits with the CHILD's code, so this is already the wrapped command's own status.
  // If the wrapper itself could not start, fall back to running the command unwrapped rather than
  // inventing a failure the command never had.
  if (r.error) plain(cmd);
  process.exit(r.status ?? 130);
}

// Importable for tests without executing anything — the same guard `bsc-doctor.mjs` uses.
if (process.argv[1]?.endsWith("record-run.mjs")) main(process.argv.slice(2));
