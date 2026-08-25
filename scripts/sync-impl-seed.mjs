// Sync a NAMED impl record's `code` — and, with `--tests`, its carried TESTS — from the store into the
// packaged seed.
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
const TESTS = process.argv.includes("--tests");
const IDS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!IDS.length) { console.error("usage: node sync-impl-seed.mjs <impl-id>… [--tests] [--apply]"); process.exit(2); }

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
  // `--tests` is the CARRY half (#a-carried-test-cannot-import-a-colocated-json-fixture). A record whose
  // file is long retired is "already seeded", so `promote-records.mjs` never reconsiders it — which left
  // no path at all for a test harvested onto such a record to reach the copy that SHIPS. The seed is what
  // `emit-records.mjs` materializes, so a test that stops in the store never runs anywhere.
  //
  // Separate flag, and never implied by a code sync: the two answer different questions (is the record
  // the same MODULE / does the record carry the same TEST) and a `--tests` that rode along with `code`
  // would move a test on a run the operator asked to be about the body.
  if (TESTS) {
    const from = JSON.stringify(s.tests ?? []);
    if (from === JSON.stringify(t.tests ?? [])) { console.log(`SKIP ${id} — tests already identical`); continue; }
    if (!(s.tests ?? []).length) { console.log(`SKIP ${id} — the STORE carries no test to sync`); continue; }
    const n = (s.tests ?? []).reduce((a, x) => a + (x?.src ?? "").length, 0);
    console.log(
      `${APPLY ? "SYNC tests" : "would sync tests"} ${id}  seed ${(t.tests ?? []).length} -> store ` +
        `${(s.tests ?? []).length} test(s), ${n} chars` +
        // A carried test with no `ext` falls back to the emitter's guess, which reads any `<Word…>` as
        // JSX and misnames the file. Say so here rather than let it surface as a dead suite.
        ((s.tests ?? []).some((x) => !x?.ext) ? "  ⚠️ a test carries no `ext` — the emitter will GUESS" : ""),
    );
    t.tests = s.tests;
    changed += 1;
    continue;
  }
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
