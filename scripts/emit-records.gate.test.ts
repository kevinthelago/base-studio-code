// EVERY entry point that consumes `.bsc-records` must regenerate it first
// (#the-dev-server-never-regenerates-the-records-cache).
//
// THE BUG THIS PINS. `npm run dev` was a bare `vite`, while `build`, `typecheck` and `test` all
// chained `emit-records.mjs`. So when 23 settings-card modules were retired into records, the dev
// server kept resolving the PRE-migration cache and died with
//
//     Failed to resolve import "@/features/settings/cards/LlmProviderCard" from ".../PlannerPage.tsx"
//
// while the whole gate stayed green — typecheck and test emit first, so they saw a fresh cache and
// passed. That asymmetry is the defect: not a gate that checks too little, but an ENTRY POINT that
// prepares less than its siblings. `tauri dev` inherited it too, since `beforeDevCommand` chains
// `npm run dev`; only the production build was ever safe, because `beforeBuildCommand` chains
// `npm run build`.
//
// A one-line fix reopens itself the moment someone adds the next vite/tsc/vitest script, so the
// guard is stated over the SET of consuming scripts rather than over `dev` alone.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** A script CONSUMES the records cache when it runs a tool that resolves `@/…` imports — vite (dev,
 *  build or preview), tsc, or vitest. Matched on the tool actually invoked rather than on a list of
 *  script names, so a newly added script is covered the day it lands. */
const CONSUMES = /\b(vite|tsc|vitest)\b/;
/** …and it PREPARES the cache when it runs the emitter first. */
const EMITS = /emit-records\.mjs/;

/** Scripts that match {@link CONSUMES} but genuinely do not read the cache. Kept as an explicit,
 *  justified list: an unexplained exemption is how the hole would quietly come back.
 *  - `preview` serves an ALREADY-BUILT `dist/`, so nothing resolves `@/…` at that point.
 *  - `test:e2e` drives the shipped preview chain in a browser (`e2e/`, #3264) and is deliberately
 *    outside the default gate; it builds what it needs itself. */
const EXEMPT = new Set(["preview", "test:e2e", "typecheck:e2e"]);

describe("every entry point that reads .bsc-records regenerates it first", () => {
  it("covers dev — the one that was broken", () => {
    // Named explicitly as well as covered by the sweep below: this is the regression, and a reader
    // scanning the file should see the actual case, not only the general rule.
    expect(pkg.scripts.dev).toMatch(EMITS);
    expect(pkg.scripts.dev).toMatch(/vite/);
  });

  it("covers every consuming script, so the next one added cannot reopen the hole", () => {
    const offenders = Object.entries(pkg.scripts)
      .filter(([name, cmd]) => !EXEMPT.has(name) && CONSUMES.test(cmd) && !EMITS.test(cmd))
      .map(([name, cmd]) => `${name}: ${cmd}`);
    expect(offenders).toEqual([]);
  });

  it("actually inspects some scripts — a guard that matches nothing would pass silently", () => {
    // Without this the two assertions above hold trivially if `scripts` is ever restructured and the
    // regexes stop matching anything at all.
    const consuming = Object.entries(pkg.scripts).filter(([n, c]) => !EXEMPT.has(n) && CONSUMES.test(c));
    expect(consuming.length).toBeGreaterThanOrEqual(4); // dev · build · typecheck · test, at least
  });
});
