// Retiring a module must not retire its TESTS (#retire-the-rest).
//
// A record carries its colocated test as DATA (`tests: [{ name, src }]`, #3907), which is the right
// long-term shape — once a component's source is a store record compiled at runtime, a `.test.tsx` under
// `src/**` is no longer beside the thing it tests. But nothing in the default gate RUNS carried tests:
// `npm test` walks `src/`, and `bsc ui test <id> --run` materializes out-of-repo, where `vitest/config`
// does not resolve without an install. So a retirement that deletes the colocated file trades EXECUTED
// coverage for STORED coverage, silently and with a green gate.
//
// That is not hypothetical — the first two retirement tranches did exactly this and took 31 assertions
// out of the gate before this guard existed. Five of them (BackButton) were not carried by the record at
// all and were simply gone.
//
// The fix is smaller than it looks: a colocated test importing `@/…` resolves through `tsconfig.paths`
// to the emitted `.bsc-records/` copy, so KEEPING the test file (with its relative import rewritten to
// the alias) means the default gate goes on running it — now against the module that actually ships,
// which is strictly better coverage than testing a bundled file the app no longer mounts.
//
// So: retire the module, keep the test. This guard is what makes that a rule rather than a habit.
import { describe, it, expect } from "vitest";

/** Every packaged seed, as the record objects the app would load. */
const seeds = import.meta.glob<{ id?: string; provides?: string; tests?: { name?: string; src?: string }[] }>(
  "@data/components/app/**/*.json",
  { eager: true, import: "default" },
);

/** Every file under `src/`, keyed the way a specifier addresses it (`@/x/y` → `x/y`). */
const srcFiles = new Set(
  Object.keys(import.meta.glob("/src/**/*.{ts,tsx}", { eager: false })).map((p) => p.replace(/^\/src\//, "")),
);

const EXT = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const hasFile = (base: string) => EXT.some((e) => srcFiles.has(base + e));

/** Is this specifier addressed at THIS app's source tree?
 *
 *  `@/components/<id>` and `@/src/…` records are foreign — mobile-studio-code screens and generated-app
 *  demos — and have no position under `src/` at all, so a colocated test is not even expressible for
 *  them. Three carry tests today (`github-empty`, `security-assignments`, `security-flow`); they are
 *  excluded because the rule cannot apply, not because the gap is acceptable. */
const isOwnSpecifier = (spec: string) =>
  ["@/app/", "@/features/", "@/shared/", "@/store/", "@/styles/"].some((p) => spec.startsWith(p));

describe("a retired module keeps its tests in the gate", () => {
  it("every RETIRED record that carries tests still has a colocated test file to run them", () => {
    const gaps: string[] = [];
    let checked = 0;
    for (const rec of Object.values(seeds)) {
      const spec = typeof rec?.provides === "string" ? rec.provides.trim() : "";
      if (!spec.startsWith("@/") || !isOwnSpecifier(spec)) continue;
      const base = spec.slice(2);
      if (hasFile(base)) continue; // the file is still here — not retired, nothing to preserve yet
      const carried = (rec.tests ?? []).reduce(
        (n, t) => n + ((t.src ?? "").match(/^\s*(it|test)\(/gm) ?? []).length,
        0,
      );
      if (!carried) continue; // a record that never had a test cannot have lost one
      checked++;
      const testFile = ["test", "spec"].flatMap((k) => [`${base}.${k}.ts`, `${base}.${k}.tsx`]).find((p) => srcFiles.has(p));
      if (!testFile) gaps.push(`${spec} — ${carried} assertion(s) stored on the record, none executed`);
    }
    expect(
      gaps,
      `retired modules whose tests left the gate. Keep the colocated test and point its import at the ` +
        `alias (\`@/…\`), which resolves to the emitted record:\n  ${gaps.join("\n  ")}`,
    ).toEqual([]);
    // Non-vacuity: if the seed glob or the specifier filter ever stops matching, an empty sweep would
    // read as a clean one. Assert the guard actually had records to judge.
    expect(checked, "the guard examined at least one retired record carrying tests").toBeGreaterThan(0);
  });
});
