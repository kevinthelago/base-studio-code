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
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGateSlot } from "./gateLock.mjs";
import { planGate, parsePorcelain, gateCommands } from "./gateScope.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const force = argv.includes("--full");
const baseIdx = argv.indexOf("--base");
const base = baseIdx >= 0 ? argv[baseIdx + 1] : "develop";

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
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

function run(label, cmd, args) {
  process.stdout.write(`\n── ${label}\n   ${cmd} ${args.join(" ")}\n`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const ok = r.status === 0;
  process.stdout.write(`   ${ok ? "PASS" : "FAIL"} (${secs}s)\n`);
  return ok;
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
  process.stdout.write(`  frontend files: ${plan.frontendFiles.length}\n`);
  if (plan.rustCrates.length >= graph.size - 2) {
    process.stdout.write(`  note: that is nearly the whole workspace — a shared crate changed, so this is\n`);
    process.stdout.write(`        barely narrower than --full. Expected, not a bug.\n`);
  }
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

// Serialize FULL gates across the fleet. One peaks at ~8 GB (jobs = 4) because nextest links ~41 test
// binaries, and this box has ~16 GB free — so two fit and the 10+ sessions this repo is meant to run
// do not (#ten-parallel-rust-sessions-will-oom-the-box). The SCOPED gate is deliberately not
// serialized: it compiles one crate plus its dependents, so making agents queue for it would trade a
// real cost against a risk they do not pose.
const releaseSlot = plan.full
  ? await acquireGateSlot((m) => process.stdout.write(`gate: ${m}\n`))
  : () => {};

// EVERY step runs, even after one fails. A gate that stops at the first failure hands back a partial
// verdict, and the whole point here is that the reader can trust what was covered.
const results = [];
for (const { label, cmd, args } of gateCommands(plan, base)) {
  results.push([label, run(label, cmd, args)]);
}

releaseSlot(); // before the exit below, and before printing — a held slot blocks the fleet

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
process.stdout.write(`\n${failed.length ? `GATE FAILED: ${failed.join(", ")}` : "gate passed"}\n`);
if (!plan.full) {
  process.stdout.write("this was the SCOPED gate — step 7 still runs `npm run gate -- --full` before merging\n");
}
process.exit(failed.length ? 1 : 0);
