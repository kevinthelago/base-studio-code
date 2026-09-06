// Regenerate src/features/tunnel/lib/storePayloads.fixtures.json from the real store_state builders.
// A thin wrapper so `npm run fixtures:store` sets UPDATE_STORE_FIXTURES cross-platform (Windows npm
// runs scripts via cmd.exe, where the bash `VAR=1 cmd` form fails, and the repo carries no cross-env).
//
// THE TEST IS A RECORD, so its path is not fixed. It used to live at
// `src/features/tunnel/lib/storePayloads.fixtures.test.ts`; the records migration retired that file
// and this script kept pointing at it, so `npm run fixtures:store` did nothing but print
// "No test files found, exiting with code 1" — vitest's way of saying the filter matched zero
// files, which reads like a config problem rather than a dead path. It was dead for as long as the
// migration has been done and nothing noticed, because nothing regenerates the fixture routinely.
//
// So: resolve the test wherever it actually is, and REFUSE rather than run vitest with a filter
// that matches nothing. A generator that exits non-zero having regenerated nothing is the same
// class of failure as a gate that passes while covering nothing.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Where the fixtures test can live: the emitted record cache first, then a real file. */
const CANDIDATES = [
  ".bsc-records/features/tunnel/lib/storePayloads.fixtures.test.ts",
  "src/features/tunnel/lib/storePayloads.fixtures.test.ts",
];

const target = CANDIDATES.find((p) => existsSync(p));
if (!target) {
  console.error(
    "fixtures:store: cannot find the store-payload fixtures test. Looked in:\n" +
      CANDIDATES.map((p) => `  ${p}`).join("\n") +
      "\nIf it is a record, run `npm run emit:records` first so the cache exists.",
  );
  process.exit(1);
}

const r = spawnSync("npx", ["vitest", "run", target], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, UPDATE_STORE_FIXTURES: "1" },
});
process.exit(r.status ?? 1);
