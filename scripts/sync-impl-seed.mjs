// Sync a NAMED impl record's `code` AND its carried `tests` from the store into the packaged seed.
//
// `tests` was added because it was a hole with no floor: `bsc graph tests set` writes the runtime
// store and `bsc graph promote` moves a record to `graph/algorithms.json`, but `emit-records.mjs` —
// and therefore the GATE, which runs the emitted `.bsc-records/**` test — reads THIS seed, and nothing
// wrote the field here. An edited carried test landed in two stores, never reached the one under test,
// and this script reported "already identical" because it only ever compared `code`. A sync that
// cannot see the field that changed is worse than no sync: it answers the question with a green line.
// Filed as `bsc request` 145 for the `bsc`-surface version of this.
//
// `promote-records.mjs` only promotes records whose FILE still exists — a record that is ALREADY the
// only copy (its file long retired) is "already seeded" and never reconsidered. So a deliberate edit
// to such a record lands in the store and stops there, and the app keeps shipping the old body.
//
// This is deliberately BY ID and never a sweep: seed and store have diverged BOTH ways across ~340
// records, and a mass re-stamp would overwrite real seed content with stale store content. It prints
// the before/after sizes so the direction of the change is visible before it is trusted.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// #139: the Windows dev-box fallback path was dead since the linux-host migration — this repo's own
// scripts run with $BSC_BIN set, so the fallback only ever fires from a bare shell, where the bundled
// binary's real home (`census-claims.mjs`'s own fallback) is the honest guess.
const BSC = process.env.BSC_BIN ?? join(process.env.HOME ?? "", ".base-studio-code", "bin", "bsc");
const SEED = "src-tauri/data/knowledge/algorithms.json";
const APPLY = process.argv.includes("--apply");
const IDS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!IDS.length) { console.error("usage: node sync-impl-seed.mjs <impl-id>… [--apply]"); process.exit(2); }

const store = new Map(
  JSON.parse(execFileSync(BSC, ["graph", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 }))
    .map((r) => [r.id, r]),
);
const seed = JSON.parse(readFileSync(SEED, "utf8"));

let changed = 0;
for (const id of IDS) {
  const s = store.get(id);
  const t = (seed.implementations ?? []).find((im) => im.id === id);
  if (!s) { console.log(`SKIP ${id} — not in the store`); continue; }
  if (!t) { console.log(`SKIP ${id} — not in the seed (that would be a PROMOTION, not a sync)`); continue; }
  // Compare each syncable field independently — a record whose `code` is unchanged may still carry an
  // edited test, and vice versa. Reporting per field keeps the direction of the change visible, which
  // is the property this script was written for.
  const moved = [];
  if ((t.code ?? "") !== (s.code ?? "")) {
    moved.push(`code ${(t.code ?? "").length} -> ${(s.code ?? "").length} chars`);
    t.code = s.code;
  }
  // `tests` is an ARRAY of { ext, name, src }, so it is compared (and moved) whole: a test can be
  // renamed, added or dropped, and a per-entry merge would have to guess which of those happened.
  const seedTests = JSON.stringify(t.tests ?? []);
  const storeTests = JSON.stringify(s.tests ?? []);
  if (seedTests !== storeTests) {
    moved.push(`tests ${seedTests.length} -> ${storeTests.length} chars`);
    if (s.tests === undefined) delete t.tests; else t.tests = s.tests;
  }
  if (!moved.length) { console.log(`SKIP ${id} — already identical`); continue; }
  console.log(`${APPLY ? "SYNC" : "would sync"} ${id}  ${moved.join("; ")}`);
  changed += 1;
}

if (APPLY && changed) {
  writeFileSync(SEED, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`wrote ${SEED} (${changed} record(s))`);
} else if (!APPLY) {
  console.log("(dry run — pass --apply to write)");
}
