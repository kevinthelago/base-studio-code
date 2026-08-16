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
import { planGate, parsePorcelain, gateCommands } from "./gateScope.mjs";

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
    : planGate({ files, graph, dirToCrate, force });

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

// EVERY step runs, even after one fails. A gate that stops at the first failure hands back a partial
// verdict, and the whole point here is that the reader can trust what was covered.
const results = [];
for (const { label, cmd, args } of gateCommands(plan, base)) {
  results.push([label, run(label, cmd, args)]);
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
process.stdout.write(`\n${failed.length ? `GATE FAILED: ${failed.join(", ")}` : "gate passed"}\n`);
if (!plan.full) {
  process.stdout.write("this was the SCOPED gate — step 7 still runs `npm run gate -- --full` before merging\n");
}
process.exit(failed.length ? 1 : 0);
