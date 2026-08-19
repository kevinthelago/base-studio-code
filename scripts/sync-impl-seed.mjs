// Sync a NAMED impl record's `code` from the store into the packaged seed.
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

const BSC = process.env.BSC_BIN ?? "C:/Users/Kevin/Projects/rust/base-studio-code/target/release/bsc.exe";
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
  if ((t.code ?? "") === (s.code ?? "")) { console.log(`SKIP ${id} — already identical`); continue; }
  console.log(`${APPLY ? "SYNC" : "would sync"} ${id}  seed ${(t.code ?? "").length} -> store ${(s.code ?? "").length} chars`);
  t.code = s.code;
  changed += 1;
}

if (APPLY && changed) {
  writeFileSync(SEED, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`wrote ${SEED} (${changed} record(s))`);
} else if (!APPLY) {
  console.log("(dry run — pass --apply to write)");
}
