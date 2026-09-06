// scripts/emit-parity.mjs — the byte-parity safety net for the imports→composes migration
// (epic `imports-are-derived-from-the-composes-graph`).
//
// The migration STRIPS hand-written import lines from record `code` and re-derives them from the
// `imports` field at emit time. If the derivation is faithful, the EMITTED tree is byte-for-byte
// unchanged. This proves that: emit the whole record tree at two git refs and diff them. A zero diff
// is proof the derived imports reproduce the hand-written ones exactly — a guarantee compilation
// alone cannot give (a differently-ordered or over-broad import still compiles).
//
// This is a TWO-REF comparison run ONCE for the migration, NOT a per-commit gate leg (a committed
// ~1577-file golden would be pure noise). The cheap per-commit guard lives in
// `emit-determinism.test.ts` (emit twice, assert identical) — this file is the migration proof.
//
//   node scripts/emit-parity.mjs --before <ref> --after <ref>
//
// It also asserts the `--plan` `unresolvable` count did NOT grow: a derivation that DROPS an import
// surfaces as both a new unresolvable AND a byte diff, so the two checks corroborate.
//
// RUST NOTE: `graph-materialize` materializes at BUILD time — there is no offline `.bsc-records`-style
// tree to snapshot — so today this covers the FRONTEND (`bsc-emit`) tree. Once `graph-materialize`
// grows an offline emit-to-dir mode (planned in the same epic), point `emitTreeAt` at it as a second
// tree and the same manifest/diff covers the Rust records unchanged.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitBinary } from "./emit-records.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A content manifest of an emitted tree: POSIX relpath → sha256 of the bytes. Pure + exported so
 *  the diff logic is unit-tested without standing up a git worktree or an emit. */
export function snapshotDir(dir) {
  const man = new Map();
  if (!existsSync(dir)) return man;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else man.set(relative(dir, p).split("\\").join("/"), createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return man;
}

/** Diff two manifests. Pure + exported. `{ onlyBefore, onlyAfter, changed }` — all empty ⇒ identical. */
export function diffManifests(before, after) {
  const onlyBefore = [];
  const onlyAfter = [];
  const changed = [];
  for (const [p, h] of before) {
    if (!after.has(p)) onlyBefore.push(p);
    else if (after.get(p) !== h) changed.push(p);
  }
  for (const p of after.keys()) if (!before.has(p)) onlyAfter.push(p);
  return { onlyBefore: onlyBefore.sort(), onlyAfter: onlyAfter.sort(), changed: changed.sort() };
}

/** Emit the whole record tree at one git ref (in a throwaway detached worktree) and return its
 *  content manifest + the `unresolvable` counts. */
function emitTreeAt(ref) {
  const wt = mkdtempSync(join(tmpdir(), "emit-parity-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", wt, ref], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
    const bin = emitBinary();
    execFileSync(bin, ["--repo", wt, "--quiet"], { stdio: ["ignore", "ignore", "inherit"] });
    const man = snapshotDir(join(wt, ".bsc-records"));
    const plan = JSON.parse(execFileSync(bin, ["--repo", wt, "--plan", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    return { man, unresolvable: (plan.unresolvable ?? 0) + (plan.edgeUnresolvable ?? 0) };
  } finally {
    try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: REPO, stdio: "ignore" }); }
    catch { rmSync(wt, { recursive: true, force: true }); }
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--before") a.before = argv[++i];
    else if (argv[i] === "--after") a.after = argv[++i];
  }
  return a;
}

// CLI entry — skipped when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("emit-parity.mjs")) {
  const { before, after } = parseArgs(process.argv.slice(2));
  if (!before || !after) {
    console.error("usage: node scripts/emit-parity.mjs --before <ref> --after <ref>");
    process.exit(2);
  }
  console.error(`[emit-parity] emitting ${before} …`);
  const b = emitTreeAt(before);
  console.error(`[emit-parity] emitting ${after} …`);
  const a = emitTreeAt(after);
  const d = diffManifests(b.man, a.man);
  const drifted = d.onlyBefore.length + d.onlyAfter.length + d.changed.length;
  if (drifted > 0) {
    console.error(`[emit-parity] FAIL — the emitted tree changed between ${before} and ${after}:`);
    for (const p of d.changed) console.error(`  changed:  ${p}`);
    for (const p of d.onlyBefore) console.error(`  removed:  ${p}`);
    for (const p of d.onlyAfter) console.error(`  added:    ${p}`);
    process.exit(1);
  }
  if (a.unresolvable > b.unresolvable) {
    console.error(`[emit-parity] FAIL — unresolvable count grew ${b.unresolvable} → ${a.unresolvable} (a derived import was dropped).`);
    process.exit(1);
  }
  console.error(`[emit-parity] OK — ${b.man.size} emitted files byte-identical across ${before}..${after}; unresolvable ${b.unresolvable} → ${a.unresolvable} (did not grow).`);
}
