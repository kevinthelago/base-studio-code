// THE PLAN-STORE PATH IS SPELLED ONCE (`one-resolver-for-the-plan-store-path`).
//
// `plans/<key>.db` was re-derived in five production sites across five crates, with THREE different key
// policies: the canonical helper SANITIZED, `plandb`'s `plan_db_for_key` VALIDATED-AND-REJECTED, and
// `bsc-project` and `bsc-session` applied NOTHING. So the same key resolved to a path, a different path,
// or an error depending on which binary asked — and `bsc-session`'s `identity::director` built the hub
// from a sanitized key and the plan store from the RAW one on adjacent lines.
//
// The mapping now lives in `bsc_util::plan_db_path` / `plan_db_in`. This leg keeps it there.
//
// WHY A SCRIPT AND NOT A RUST TEST. The rule is over the whole record tree, which is the case CLAUDE.md
// sends here. It also has to be LANE-AWARE: a Rust test reading the committed store sees `main`, so on the
// very branch that does the conversion it would report the OLD bodies and be red for the wrong reason.
// `loadStore` overlays the checkout's lane, so this leg sees what the build actually compiles.
//
// It greps for the SPELLING, not for behaviour, and that is deliberate: the failure this prevents is
// someone writing the path out again rather than calling the helper, which is a textual act.
import { loadStore, resolveStorePath } from './lib/recordStore.mjs';

const STORE = resolveStorePath(process.cwd());
const store = loadStore(STORE);

// The construction to refuse: joining a literal `plans` segment onto a base directory. Matched loosely
// (any whitespace) so a reformat cannot slip past it.
const SPELLING = /\.join\(\s*"plans"\s*\)/;

// WHO MAY SPELL IT.
//
// `bsc-util--lib.rs` is the definition. Its own tests assert the mapping, so they must state it too —
// a guard that forbade that would forbid testing the thing it protects.
//
// `src-tauri--platform--paths--plans-root.rs` keeps ONE fallback. Its `plans_root()` returns a plain
// `PathBuf` while `bsc_util::plans_root()` returns an `Option`, and src-tauri's own `bsc_base_dir()`
// cannot be `None` — so the fallback is a type obligation, not a second policy. It is allow-listed by
// NAME rather than by pattern so that adding a second one is a decision somebody has to make here.
const ALLOWED = new Set([
  'bsc-util--lib.rs',
  'bsc-util--tests.rs',
  'src-tauri--platform--paths--plans-root.rs',
]);

// A TEST FIXTURE MAY BUILD A FAKE LAYOUT. `dir.join("plans")` in a test constructs a scratch tree to read
// back; it does not resolve this install's store, and forbidding it would push every fixture into a helper
// for no gain.
//
// DETECTED BY POSITION, NOT BY RECORD ID. In this tree a Rust test lives INSIDE the production record, in
// its `#[cfg(test)] mod tests` block — so an id-based check missed all six real cases and the guard read as
// clean over exactly the records it should have been explaining. A line at or after the first `#[cfg(test)]`
// is test code.
//
// TWO CHECKS ARE NEEDED, and each was measured missing the other's cases. A DEDICATED test record
// (`bsc-session--launch-plan--tests.rs`, `bsc-studio--tests.rs`) has no `#[cfg(test)]` of its own — the
// whole record IS the test module, declared by its parent — so position alone reported 3 of those as
// offenders. Conversely six production records hold their fixtures in an inline block, so the id check
// alone missed all six. Neither is redundant.
const isTestRecord = (id) => /(^|--)tests?(--|\.rs$)|--test-|-tests\.rs$/.test(id);

// The conservative direction is deliberate: if a record has NO `#[cfg(test)]`, nothing is excused.
const testFrom = (code) => {
  const lines = code.split('\n');
  const i = lines.findIndex((l) => l.includes('#[cfg(test)]'));
  return i === -1 ? Infinity : i + 1; // 1-based: the marker line itself is already test scaffolding
};

// `loadStore` returns the LEDGER shape — `{ implementations, edges }` — not a map keyed by id. Iterating
// `Object.entries(store)` therefore yields TWO entries and a guard that checks nothing while printing
// success, which is this repo's signature failure and was this file's first draft.
const records = store.implementations ?? [];
if (records.length < 100) {
  console.error(`plan-store path: read only ${records.length} record(s) from ${STORE} — that is not the
  store, and a guard that checks nothing must FAIL rather than pass. Has loadStore's shape changed?`);
  process.exit(1);
}

const offenders = [];
let checked = 0;
for (const rec of records) {
  const id = rec?.id;
  if (!id || ALLOWED.has(id) || isTestRecord(id)) continue;
  checked += 1;
  const code = typeof rec.code === 'string' ? rec.code : '';
  if (!SPELLING.test(code)) continue;
  const cutoff = testFrom(code);
  const lines = code
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([n, l]) => SPELLING.test(l) && n < cutoff);
  if (lines.length > 0) offenders.push({ id, lines });
}

if (offenders.length === 0) {
  console.log(
    `plan-store path: one spelling — ${checked} of ${records.length} records checked ` +
    `(${ALLOWED.size} allow-listed, the rest test fixtures)`,
  );
  process.exit(0);
}

console.error(`PLAN-STORE PATH GATE: ${offenders.length} record(s) spell the plan-store path themselves:`);
for (const { id, lines } of offenders) {
  console.error(`  ${id}`);
  for (const [n, l] of lines) console.error(`    :${n}  ${l.trim()}`);
}
console.error(`
  call the ONE mapping instead:
    bsc_util::plan_db_path(key)              // this install's base dir
    bsc_util::plan_db_in(base, key)          // an injected base dir (tests, backup src/dest)
    bsc_util::plans_root() / plans_root_in(base)
  it applies ONE key policy (sanitize, idempotent) and honours $BSC_PLANS_DIR, so a key resolves to the
  same file in every binary. See \`one-resolver-for-the-plan-store-path\`.`);
process.exit(1);
