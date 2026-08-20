#!/usr/bin/env node
// Report (and optionally repair) drift between the COMMITTED impl seed and the LIVE impl store.
//
// WHY THIS EXISTS. There are two record stores and a page depends on both: `bsc ui` holds the
// components (pages), `bsc graph impl` holds the logic modules they import. An impl record's
// `provides` BEATS the platform registry, so a stale impl in the live store is handed to the page
// even when the app bundle is perfectly correct. The symptom is a runtime TypeError on a function
// that exists everywhere you would think to look:
//
//     TypeError: (0 , import_logsBridge.logsCosts) is not a function
//
// NO GATE CAN SEE IT. `tsc` and vitest read `.bsc-records/`, emitted FROM the seed. The e2e mount
// oracle compiles from the PACKAGED catalogue. Every one of them reads a copy that is right; the
// only wrong copy is the one on the user's disk, and it is only observable in a running app, on the
// tab, after the poll fires. On 2026-08-19 thirty-one impls were drifted and three Logs tabs were
// each broken; one was found by a user clicking it.
//
//   node scripts/impl-store-drift.mjs            # report
//   node scripts/impl-store-drift.mjs --fix      # push the seed copy for every drifted impl
//   node scripts/impl-store-drift.mjs --fix --include-provides
//
// `--fix` deliberately SKIPS a record whose only drift is a `provides` the live store never had:
// adding a global override is a behaviour change, not a sync, so it needs the explicit flag.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SEED = join(REPO, "src-tauri/data/knowledge/algorithms.json");
const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const INCLUDE_PROVIDES = args.includes("--include-provides");

/** The bundled binary, and WHY a miss is reported rather than shrugged off.
 *
 * The first version returned null on any failure and the caller printed "no reachable impl store —
 * skipped". That is a lying diagnostic: a worktree whose `target/debug/bsc.exe` is a stale stub fails
 * with EFTYPE, and the tool cheerfully reported nothing wrong. A drift checker that cannot tell
 * "clean" from "I could not look" is worse than no checker, because it is quoted as evidence.
 *
 * Candidates in order; the LAST error is kept so the caller can say what actually happened.
 */
let lastErr = null;
function bsc(argv) {
  const roots = [REPO, join(REPO, "..")];   // a worktree often has no built binary; the main repo does
  for (const root of roots) {
    for (const bin of ["target/release/bsc.exe", "target/debug/bsc.exe"]) {
      const exe = join(root, bin).replace(new RegExp(String.fromCharCode(92, 92), "g"), "/");
      try {
        return execFileSync(exe, argv, {
          encoding: "utf8",
          // `graph impl list` is megabytes; the 1 MB default fails as ENOBUFS, which the old
          // catch-all also swallowed into "no store".
          maxBuffer: 64 * 1024 * 1024,
          // MSYS path conversion rewrites a leading `/` — it turned `@/shared/lib/core/logsBridge`
          // into `@C:/Program Files/Git/shared/...`, i.e. a BROKEN global override. Off, always.
          env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
        });
      } catch (e) {
        lastErr = `${exe}: ${e.code ?? e.message}`;
      }
    }
  }
  return null;
}
const seed = new Map(
  JSON.parse(readFileSync(SEED, "utf8")).implementations.map((i) => [i.id, i]),
);

const rawList = bsc(["graph", "impl", "list"]);
if (rawList === null) {
  // Say WHICH binary and WHY. "skipped" with no reason reads as "nothing to report".
  console.log(`impl-store-drift: could not reach the impl store — ${lastErr ?? "no bsc binary found"}`);
  console.log("   Build one (`cargo build -p bsc --bin bsc`) or run this from the main repo.");
  process.exit(0);
}
let listed;
try {
  listed = JSON.parse(rawList);
} catch (e) {
  console.log(`impl-store-drift: the impl store returned unparseable JSON — ${e.message}`);
  process.exit(1);
}
const live = new Set(listed.map((x) => x.id));

const drift = [];
for (const [id, s] of seed) {
  if (!live.has(id)) continue;
  let L;
  try {
    L = JSON.parse(bsc(["graph", "impl", "get", id]) ?? "null");
  } catch {
    continue;
  }
  if (!L) continue;
  if (L.code !== s.code) drift.push({ id, what: "code" });
  else if ((L.provides ?? null) !== (s.provides ?? null)) {
    // A provides the live store NEVER had is an ADDITION, not a stale copy.
    drift.push({ id, what: "provides", adding: L.provides == null && s.provides != null });
  }
}
const missing = [...seed.keys()].filter((id) => !live.has(id));

if (drift.length === 0) {
  console.log(`impl-store-drift: clean — ${seed.size} seed impls, none drifted.`);
} else {
  console.log(`impl-store-drift: ${drift.length} DRIFTED of ${seed.size}\n`);
  for (const d of drift) {
    console.log(`   ${d.id.padEnd(34)} ${d.what}${d.adding ? "  (would ADD an override)" : ""}`);
  }
  console.log(
    "\n   A drifted impl is handed to every page that imports it — `provides` beats the platform\n" +
      "   registry, so the app bundle being correct does not save you. Repair with --fix.",
  );
}
if (missing.length) console.log(`\n   ${missing.length} seed impl(s) absent from the live store: ${missing.join(", ")}`);

if (!FIX || drift.length === 0) process.exit(0);

const tmp = mkdtempSync(join(tmpdir(), "impl-sync-"));
let fixed = 0, held = 0;
for (const d of drift) {
  if (d.adding && !INCLUDE_PROVIDES) { held++; continue; }
  const s = seed.get(d.id);
  const codeFile = join(tmp, `${d.id.replace(/\W/g, "_")}.code`);
  writeFileSync(codeFile, s.code, "utf8");
  // `--code-file`, never `--code`: a module exceeds the argv limit and the shell silently corrupts
  // backticks and `\n` on the way through.
  const argv = ["graph", "impl", "set", "--tech", s.tech ?? "typescript", "--id", d.id,
    "--role", s.role ?? "algorithm", "--name", s.name ?? d.id, "--code-file", codeFile,
    "--by", "seed-sync", "--note", "impl-store-drift --fix: sync the live store with the committed seed"];
  if (s.provides) argv.push("--provides", s.provides);
  if (s.src) argv.push("--src", s.src);
  bsc(argv);
  const back = JSON.parse(bsc(["graph", "impl", "get", d.id]) ?? "null");
  if (back && back.code === s.code && (back.provides ?? null) === (s.provides ?? null)) fixed++;
  else console.log(`   FAILED ${d.id} — read back as provides=${JSON.stringify(back?.provides)}`);
}
console.log(`\nimpl-store-drift: synced ${fixed}${held ? `, held ${held} (pass --include-provides to add those overrides)` : ""}`);
console.log("   A RUNNING APP CACHES THE STORE AT BOOT — restart it, or the sync is invisible.");
