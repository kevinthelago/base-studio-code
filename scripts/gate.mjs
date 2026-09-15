/**
 * The gate — scoped by default, full on demand.
 * (#the-gate-runs-everything-on-every-item-regardless-of-what-changed)
 *
 *   npm run gate            # only what this change can affect
 *   npm run gate -- --full  # the documented unscoped gate (what step 7 runs before a merge)
 *   npm run gate -- --base origin/develop
 *
 * Scoping is for ITERATING. The unscoped gate still runs at step 7 before anything lands, because this
 * repo's recurring failure is a gate that passes while covering less than the reader assumes — so the
 * narrowing has to be temporary AND visible. This prints the plan every time for that second reason.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { formatLeakReport, tempLeakLeg, withGateTmp } from "./lib/gateTmp.mjs";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { acquireGateSlot } from "./gateLock.mjs";
import { planGate, parsePorcelain, gateCommands, isRecordStorePath, needsGateSlot } from "./gateScope.mjs";
import { decideGateTree, devPortFrom } from "./gate-tree-guard.mjs";
import { classifyBuildFailure, failingPackage } from "./build-artifact-plan.mjs";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const force = argv.includes("--full");
const baseIdx = argv.indexOf("--base");
const base = baseIdx >= 0 ? argv[baseIdx + 1] : "develop";

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

/** Is something LISTENING on `port` of the loopback interface? A synchronous probe, because the gate
 *  runs top-level and this must answer before any build starts. Implemented by connecting rather
 *  than by shelling out to `ss`/`netstat`, which differ per platform and are absent on Windows.
 *  ANY failure answers "no" — an inconclusive probe must never block a gate. */
function portIsListening(port) {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const s=require("net").connect(${port},"127.0.0.1");` +
        `s.setTimeout(400);` +
        `s.on("connect",()=>{s.destroy();process.exit(0)});` +
        `s.on("timeout",()=>{s.destroy();process.exit(1)});` +
        `s.on("error",()=>process.exit(1));`,
    ],
    { encoding: "utf8", timeout: 3000 }
  );
  return probe.status === 0;
}
// UNTRIMMED — `git status --porcelain` encodes status in the first two COLUMNS, so trimming the block
// eats the leading space of the first line and shifts its path by one. See `parsePorcelain`.
const shRaw = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

/** Changed files vs `base`, PLUS anything uncommitted — mid-work is the normal case for this command. */
function changedFiles() {
  const out = new Set();
  try {
    for (const f of sh("git", ["diff", "--name-only", `${base}...HEAD`]).split("\n")) if (f) out.add(f);
  } catch {
    // No merge base (a detached or unrelated checkout). Falling back to "everything" is the safe
    // direction: a scope we cannot compute must not silently become a small one.
    return null;
  }
  for (const f of parsePorcelain(shRaw("git", ["status", "--porcelain"]))) out.add(f);
  return [...out].sort();
}

/** Workspace graph + dir→package-name map, from cargo metadata (0.55s measured). */
function workspace() {
  const meta = JSON.parse(sh("cargo", ["metadata", "--no-deps", "--format-version", "1"]));
  const names = new Set(meta.packages.map((p) => p.name));
  const graph = new Map();
  const dirToCrate = new Map();
  for (const p of meta.packages) {
    graph.set(p.name, p.dependencies.map((d) => d.name).filter((n) => names.has(n)));
    const m = /[/\\]crates[/\\]([^/\\]+)[/\\]Cargo\.toml$/.exec(p.manifest_path);
    if (m) dirToCrate.set(m[1], p.name);
  }
  return { graph, dirToCrate };
}

/**
 * Run one gate leg, and RECORD WHAT IT COST.
 *
 * The gate is the one command every worktree agent runs, and it is where the expensive builds actually
 * happen — cargo, vitest, tsc. It has always printed each leg's seconds and thrown them away, so this
 * project has hand-measured build figures written into CLAUDE.md and no history behind any of them.
 * Now every leg lands a row, and `bsc cost build --source gate:clippy` is a trend rather than a memory.
 *
 * MEASURE-ONLY, and that is the whole reason this is safe to do here. `CLAUDE.md` is explicit that the
 * gate must not file faults — ten worktree agents gating in parallel would pin every project node red
 * and destroy the signal — so the wrapper records cost and files nothing. It also INHERITS stdio
 * rather than piping, so cargo's live progress survives; a gate that looks frozen is a gate people
 * stop running.
 *
 * Through `record-run.mjs`, not `bsc` directly, for its degrade: on a fresh clone there is no usable
 * binary yet (the gate may be what builds it), and there the wrapper runs the command plainly and
 * records nothing. A gate that could not run without a working `bsc` would be a worse trade than
 * missing measurements.
 */
/** Where the machine-readable verdict lands, for anything that needs the RESULT rather than the log.
 *
 *  Under `target/` because it is per-worktree build output, never committed: two worktrees gate
 *  independently and must not overwrite each other's answer.
 *
 *  IT EXISTS SO NOTHING HAS TO PARSE THE HUMAN OUTPUT. `run` streams each leg with `stdio: "inherit"`
 *  precisely so cargo's live progress survives, which means the interesting result is interleaved with
 *  megabytes of compiler chatter and is not recoverable afterwards. A reader that scraped `PASS`/`FAIL`
 *  lines out of that would break the first time a leg's own output contained one.
 *  (#the-gate-does-not-record-its-own-evidence-so-a-session-transcribes-it)
 */
const RESULT_PATH = join(REPO, "target", "gate-result.json");

/** Write the verdict. Best-effort by design: a gate that FAILED because it could not write its own
 *  report would be a worse trade than a missing report, and the exit code below is still the truth. */
function writeResult(payload) {
  try {
    mkdirSync(dirname(RESULT_PATH), { recursive: true });
    writeFileSync(RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    /* the exit code is still correct; a reader that finds no artifact says so rather than inventing one */
  }
}

/**
 * The tests nextest reports as failed, as `<classname>::<name>` — `plandb::validate::tests::foo`.
 *
 * Only for the nextest leg; every other leg leaves `failures` empty and is excused leg-level as
 * before (`tsc` reports a program, `eslint` a file set — neither can enumerate).
 *
 * Returns [] on ANY problem rather than throwing. A gate that dies because a report was missing would
 * be worse than one that cannot name a failure — and `classify` treats empty as unknown and refuses
 * to excuse, so the safe direction is already the default.
 */
function nextestFailures(key) {
  if (key !== "nextest") return [];
  try {
    const xml = readFileSync(join(REPO, "target", "nextest", "default", "junit.xml"), "utf8");
    const out = [];
    for (const chunk of xml.split("<testcase ").slice(1)) {
      const body = chunk.slice(0, chunk.indexOf("</testcase>") + 1 || chunk.indexOf("/>") + 1);
      if (!body.includes("<failure") && !body.includes("<error")) continue;
      const name = /name="([^"]*)"/.exec(chunk)?.[1];
      const cls = /classname="([^"]*)"/.exec(chunk)?.[1];
      if (name) out.push(cls ? `${cls}::${name}` : name);
    }
    return out;
  } catch {
    return [];
  }
}

function run(label, cmd, args, leg = {}) {
  process.stdout.write(`\n── ${label}\n   ${cmd} ${args.join(" ")}\n`);
  const t = Date.now();
  const measured = leg.key
    ? [process.execPath, [join(REPO, "scripts", "record-run.mjs"),
        "--measure-only", "--stage", leg.stage ?? "build", "--source", `gate:${leg.key}`,
        "--", cmd, ...args]]
    : [cmd, args];
  const r = spawnSync(measured[0], measured[1], { stdio: "inherit", shell: process.platform === "win32" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const ok = r.status === 0;
  process.stdout.write(`   ${ok ? "PASS" : "FAIL"} (${secs}s)\n`);
  return { ok, seconds: Number(secs) };
}

const files = changedFiles();
const { graph, dirToCrate } = workspace();
const plan =
  files === null
    ? { full: true, reason: `no merge base against '${base}' — refusing to guess a smaller scope`, runVitest: true, runTsc: true, rustCrates: [], frontendFiles: [] }
    // `exists` filters DELETED files out of the lint list — eslint refuses a pattern that matches
    // nothing and fails the step. Injected here rather than read inside `planGate`, which stays pure.
    : planGate({ files, graph, dirToCrate, force, exists: (f) => existsSync(join(REPO, f)) });

// The plan is printed BEFORE anything runs, always. A gate that quietly covers less is the failure mode
// this whole change has to avoid becoming.
process.stdout.write(`\ngate: ${plan.full ? "FULL" : "SCOPED"} — ${plan.reason}\n`);
if (!plan.full) {
  process.stdout.write(`  changed files : ${files.length}\n`);
  process.stdout.write(`  rust crates   : ${plan.rustCrates.length ? plan.rustCrates.join(" ") : "(none)"}\n`);
  // Say WHY the lint list is empty when it is. `frontend files: 0` on a change that really IS
  // frontend is what hid the record-store misclassification for three merges: it reads as "there
  // is no frontend change" when it meant "none that eslint can be pointed at". A record store is
  // JSON holding TypeScript, so it counts for tsc/vitest and never for lint.
  const recordStores = files.filter(isRecordStorePath);
  const lintNote = recordStores.length
    ? ` (+${recordStores.length} record store${recordStores.length === 1 ? "" : "s"} — frontend source, excluded from lint)`
    : "";
  process.stdout.write(`  frontend files: ${plan.frontendFiles.length}${lintNote}\n`);
  if (plan.vitestUnscoped) {
      // NAME THE TRIGGER: two different rules reach this — a record store, or a DELETION — and a note
      // that does not say which one teaches the reader to skip it.
      process.stdout.write(`  note: vitest runs UNSCOPED — ${plan.unscopedReason}.\n`);
    // Say it here, BEFORE the wait. This plan calls itself scoped and is about to queue like a full one;
    // without a line saying why, the pause reads as a hang in the one tier nobody expects to wait.
    process.stdout.write(`        this makes it a HEAVY gate, so it takes a fleet slot like --full does.\n`);
  }
  if (plan.rustCrates.length >= graph.size - 2) {
    process.stdout.write(`  note: that is nearly the whole workspace — a shared crate changed, so this is\n`);
    process.stdout.write(`        barely narrower than --full. Expected, not a bug.\n`);
  }
}

// REFUSE TO BUILD IN A TREE WHOSE DEV SERVER IS LIVE
// (#a-corrupt-build-artifact-has-no-recovery-path). `tauri dev` owns that tree's `target/`, and a
// second cargo there is the condition under which both observed corruptions happened: a 0-byte
// `target/debug/bsc` (twice) and a 40-minute app link failure, with `cargo check` passing throughout.
//
// Keyed on the dev server actually LISTENING, not on "this is the main tree" — a solo gate in a
// quiet main tree is fine and refusing it would obstruct daily work for a risk that is not present.
// A probe that cannot answer counts as "no dev server": a guard that fails closed on its own
// uncertainty would block the fleet the first time a config moved.
{
  let devServerUp = false;
  try {
    const conf = JSON.parse(readFileSync(join(REPO, "src-tauri", "tauri.conf.json"), "utf8"));
    const port = devPortFrom(conf);
    if (port) devServerUp = portIsListening(port);
  } catch {
    // unreadable config ⇒ treat as no dev server (see above)
  }
  // A LINKED worktree has `.git` as a FILE (`gitdir: …`); the main worktree has it as a DIRECTORY.
  // That is the cheapest portable way to ask "am I the tree `tauri dev` runs in" — and it is what
  // keeps this guard from firing in the other worktrees, where the same global dev port is visible.
  let isMainWorktree = false;
  try {
    isMainWorktree = statSync(join(REPO, ".git")).isDirectory();
  } catch {
    // no .git at all ⇒ not the main worktree ⇒ never refuse
  }
  const verdict = decideGateTree({
    isMainWorktree,
    devServerUp,
    override: process.env.BSC_GATE_ALLOW_DEV_TREE === "1",
  });
  if (!verdict.allow) {
    process.stderr.write(`\ngate: REFUSED — ${verdict.reason}\n\n`);
    process.exit(2);
  }
  if (verdict.reason) process.stdout.write(`gate: ${verdict.reason}\n`);
}

// Materialize every `Cargo.toml` from its record BEFORE any cargo step. The manifests are generated
// and git-ignored (`graph/manifests/` is the source), and a fresh `git worktree add` checks out only
// TRACKED files — so without this line a new worktree has no manifests at all and every cargo leg
// fails with something that names a missing file rather than a missing build step.
//
// Placed here for the same reason the sweep below is: the gate is the ONE command every worktree agent
// runs. It is idempotent and writes nothing when the tree is already in sync, so the cost on a warm
// tree is one directory read.
{
  const emit = spawnSync(process.execPath, [join(REPO, "scripts/emit-manifests.mjs"), REPO], {
    encoding: "utf8",
  });
  if (emit.status !== 0) {
    process.stderr.write(`\ngate: REFUSED — cannot materialize the crate manifests:\n${emit.stderr ?? ""}\n`);
    process.exit(2);
  }
  const wrote = /^(\d+) written/m.exec(emit.stdout ?? "")?.[1];
  if (wrote && wrote !== "0") process.stdout.write(`gate: materialized ${wrote} manifest(s) from records\n`);
}

// And materialize `.bsc-records/` BEFORE any frontend leg, for exactly the reason above one directory
// over. `tsc`, `vitest` and `vite build` all resolve ~1,600 modules out of that tree, it is git-ignored,
// and a fresh `git worktree add` has none of it — so without this the frontend legs test whatever
// happens to be on disk.
//
// THIS GAP WAS REAL AND IT COST A PROMOTE. `npm test` and `npm run typecheck` both run
// `emit-records.mjs` first (see package.json); the gate called `npx vitest run` directly and did not.
// MEASURED in `wt-integrate`: a stale emitter left 1,604 seed-derived modules where the committed store
// holds 1,609, `npm test` passed and the gate's own vitest leg failed on the same tree — which reads as
// "the tests disagree with themselves" rather than "the gate is testing a different tree".
//
// Idempotent like the manifests emit: it writes nothing when the tree is in sync.
{
  const emit = spawnSync(process.execPath, [join(REPO, "scripts/emit-records.mjs")], {
    encoding: "utf8",
    cwd: REPO,
  });
  if (emit.status !== 0) {
    process.stderr.write(`\ngate: REFUSED — cannot materialize the record tree:\n${emit.stderr ?? ""}\n`);
    process.exit(2);
  }
  const n = /^emit-records: (\d+) file\(s\) written/m.exec(emit.stdout ?? "")?.[1];
  if (n && n !== "0") process.stdout.write(`gate: materialized ${n} record module(s) from the store\n`);
}

/** The path of a `bsc` on this tree that actually WORKS, or null.
 *
 *  Existence is not enough: a ZERO-BYTE `target/debug/bsc` — what the file IS for the seconds cargo is
 *  linking it, and what `cargo clippy --workspace --all-targets` leaves behind — execs through bash as
 *  an EMPTY SCRIPT and exits 0 printing nothing, which is indistinguishable from every command passing.
 *  `pickUsable` stats the file and then demands a real handshake.
 *
 *  Extracted because there are now TWO callers. It was inlined at the disk-sweep below; a second copy
 *  would be a second place for the handshake to drift out of. */
function usableBsc() {
  try {
    return (
      pickUsable(candidatePaths(REPO, homedir(), join), {
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
      })?.path ?? null
    );
  } catch {
    return null;
  }
}


// Sweep this tree's build garbage before the heavy steps. The gate is the ONE command every worktree
// agent runs, and until this line existed the sweeps hung off `build:plan` — i.e. off `tauri dev` —
// so the only tree ever collected was the one where the app gets launched, and no worktree had been
// swept once (#the-gc-never-runs-where-the-garbage-is). `gc` stamps the tree, so this is ~0ms on
// repeat runs during iteration, and it can never fail: it swallows everything and exits 0.
//
// NOW A `bsc` VERB (#the-disk-and-worktree-surface-moves-into-a-rust-crate). It is resolved through
// `bscBinary.mjs` — the build tree's own answer to "where is a usable bsc", already used by
// `record-run.mjs` two steps below for the same reason. Existence is not enough: a ZERO-BYTE `bsc`
// (what `target/debug/bsc` IS for the seconds it is being linked) execs through bash as an empty
// script and exits 0 printing nothing, which is indistinguishable from a clean sweep.
//
// A MISSING OR UNUSABLE bsc DEGRADES TO NO SWEEP, deliberately, and this is the same trade
// `record-run` already makes one step away: a gate that could not run without a working `bsc` would
// be a worse deal than a tree that goes uncollected for one run. The cost is bounded — the next gate
// with a usable binary collects everything this one skipped, because eligibility is a function of
// mtime, not of having been offered before.
try {
  const bsc = usableBsc();
  if (bsc) {
    const gc = spawnSync(bsc, ["disk", "gc", "--quiet"], { encoding: "utf8" });
    if (gc.stdout?.trim()) process.stdout.write(`${gc.stdout.trim()}\n`);
  }
} catch {
  // a janitor must never redden a gate
}

// Serialize the EXPENSIVE gates across the fleet — see `needsGateSlot`, which owns the rule and is
// unit-tested. A full gate peaks at ~8 GB (jobs = 4) because nextest links ~41 test binaries, and this
// box has ~16 GB free, so two fit and the 10+ sessions this repo is meant to run do not
// (#ten-parallel-rust-sessions-will-oom-the-box).
//
// A SCOPED GATE IS NOT AUTOMATICALLY A CHEAP ONE, which is what this used to assume. Keying the slot on
// `plan.full` exempted every gate that ran vitest UNSCOPED — the whole 768-file suite — because such a
// plan still calls itself scoped. Measured on the live box: 6 concurrent vitest runs and 28 workers,
// 11.45 GB of an 18.19 GB peak, not one of them holding a slot.
const releaseSlot = needsGateSlot(plan)
  ? await acquireGateSlot((m) => process.stdout.write(`gate: ${m}\n`))
  : () => {};

// EVERY step runs, even after one fails. A gate that stops at the first failure hands back a partial
// verdict, and the whole point here is that the reader can trust what was covered.
const results = [];
// Every leg runs with its temp directory OFF the /tmp tmpfs, and whatever it leaves is named and removed
// (`the-test-suites-leak-temp-dirs-into-tmp`). What was left is its own leg, `temp-leaks`, and it FAILS the
// gate (`the-test-suites-still-leak-temp-entries-per-gate`): it was report-only while ~30 tests leaked, and
// once they were all fixed a report could no longer stop the next one.
let leaked = [];
await withGateTmp(async () => {
  for (const { label, cmd, args, key, stage } of gateCommands(plan, base)) {
    const { ok, seconds } = run(label, cmd, args, { key, stage });
    // WHICH TESTS FAILED, so a known-red declaration can excuse the failure it NAMES rather than every
    // failure in the leg it lives in. Read off nextest's JUnit report (`.config/nextest.toml`) rather
    // than off stdout, because `run` inherits stdio on purpose and piping would cost cargo's live
    // progress. Empty means UNKNOWN — `bsc-work`'s `classify` fails closed on it.
    const failures = ok ? [] : nextestFailures(key);
    // `key` is the leg's STABLE id — the same one `record-run.mjs` measures under as `gate:<key>`, so a
    // scoped and a full run of one leg share an identity instead of splitting into two that can never be
    // compared. It is what a change record's gate evidence is filed under; `label` is prose and may be
    // reworded ("lint" vs "lint (changed files)") without breaking a reader.
    results.push({ key: key ?? label, label, ok, seconds, failures });
  }
}, {
  report: (leaks) => {
    leaked = leaks;
    process.stdout.write(`\n${formatLeakReport(leaks)}\n`);
  },
});
results.push(tempLeakLeg(leaked));

releaseSlot(); // before the exit below, and before printing — a held slot blocks the fleet

const failed = results.filter((r) => !r.ok).map((r) => r.label);
writeResult({
  version: 1,
  mode: plan.full ? "full" : "scoped",
  reason: plan.reason,
  finishedAt: new Date().toISOString(),
  passed: failed.length === 0,
  legs: results,
});
process.stdout.write(`\n${failed.length ? `GATE FAILED: ${failed.join(", ")}` : "gate passed"}\n`);
// A failing RUST step may be an artifact problem wearing a compiler error's clothes — an
// `undefined hidden symbol` link failure passes `cargo check` and looks nothing like a stale
// target/. Point at the reader that can tell them apart.
//
// The gate does NOT classify the step's own stderr, deliberately: `run` uses `stdio: "inherit"` so
// cargo's progress streams live, and buffering it to pattern-match would leave the gate looking
// frozen through every long compile. A pointer costs one line and no output fidelity.
if (failed.some((n) => /check|clippy|test|nextest|build/i.test(n))) {
  process.stdout.write(
    "  if a step failed while LINKING (`undefined hidden symbol`, `invalid metadata`), that is a\n" +
      "  corrupt artifact set, not your code — `npm run diagnose:build -- <log>` names it and prints the fix\n"
  );
}
if (!plan.full) {
  process.stdout.write("this was the SCOPED gate — step 7 still runs `npm run gate -- --full` before merging\n");
}
process.exit(failed.length ? 1 : 0);
