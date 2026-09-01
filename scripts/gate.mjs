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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGateSlot } from "./gateLock.mjs";
import { planGate, parsePorcelain, gateCommands, isRecordStorePath, needsGateSlot } from "./gateScope.mjs";
import { decideGateTree, devPortFrom } from "./gate-tree-guard.mjs";
import { classifyBuildFailure, failingPackage } from "./build-artifact-plan.mjs";

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
 * Now every leg lands a row, and `bsc mem build --source gate:clippy` is a trend rather than a memory.
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

// Sweep this tree's build garbage before the heavy steps. The gate is the ONE command every worktree
// agent runs, and until this line existed the sweeps hung off `build:plan` — i.e. off `tauri dev` —
// so the only tree ever collected was the one where the app gets launched, and no worktree had been
// swept once (#the-gc-never-runs-where-the-garbage-is). `gc` day-stamps itself, so this is ~0ms on
// repeat runs during iteration, and it can never fail: it swallows everything and exits 0.
try {
  const gcScript = fileURLToPath(new URL("./gc.mjs", import.meta.url));
  const gc = spawnSync(process.execPath, [gcScript, "--quiet"], { encoding: "utf8" });
  if (gc.stdout?.trim()) process.stdout.write(`${gc.stdout.trim()}\n`);
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
for (const { label, cmd, args, key, stage } of gateCommands(plan, base)) {
  const { ok, seconds } = run(label, cmd, args, { key, stage });
  // `key` is the leg's STABLE id — the same one `record-run.mjs` measures under as `gate:<key>`, so a
  // scoped and a full run of one leg share an identity instead of splitting into two that can never be
  // compared. It is what a change record's gate evidence is filed under; `label` is prose and may be
  // reworded ("lint" vs "lint (changed files)") without breaking a reader.
  results.push({ key: key ?? label, label, ok, seconds });
}

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
