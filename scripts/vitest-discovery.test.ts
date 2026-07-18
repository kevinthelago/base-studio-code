// Regression tests for test-DISCOVERY excludes (#3379).
//
// The original bug: `vitest.config.ts` had an `exclude` list, but it sat under `coverage`, so it
// governed instrumentation only. With no top-level `test.exclude`, the default include glob walked
// nested git worktrees (`wt<issue>/`, `.claude/worktrees/<branch>/`) and a root run collected every
// test file once PER worktree — 5477 files instead of 612 with eight worktrees present, so one
// failure was reported nine times and the counts were meaningless.
//
// Two properties made it a bug, and both are pinned here: the patterns must EXIST (content), and
// they must be wired at `test.exclude` rather than stranded under `coverage` (placement).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { testExclude } from "../vitest.excludes";

// Resolved from the project root Vitest runs in — `import.meta.url` is not a file URL once the
// test is transformed for the jsdom environment.
const configSource = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");

describe("vitest discovery excludes: content", () => {
  it("excludes the wt<issue>/ and .claude/worktrees/ nested checkouts", () => {
    expect(testExclude).toContain("**/wt*/**");
    expect(testExclude).toContain("**/.claude/worktrees/**");
  });

  it("PRESERVES vitest's default excludes rather than replacing them", () => {
    // Replacing (instead of spreading) configDefaults.exclude would silently re-admit
    // node_modules/dist to discovery — a far worse leak than the one being fixed.
    for (const pattern of configDefaults.exclude) {
      expect(testExclude).toContain(pattern);
    }
  });

  it("targets no pattern at the config root's OWN src tree (keeps #1669 zero-install runs working)", () => {
    // Patterns match RELATIVE to the config root, so from INSIDE a worktree that worktree's tests
    // are plain `src/**` paths — the `wt*` segment is not part of the relative path and cannot
    // match. Guard the one way that could regress: a pattern aimed at `src/` itself.
    expect(testExclude.filter((pattern) => /(^|\/)src(\/|$)/.test(pattern))).toEqual([]);
  });
});

describe("vitest discovery excludes: placement in vitest.config.ts", () => {
  it("wires an exclude at test level, not only under coverage", () => {
    // The bug was placement, not content: a correct list in the wrong place is still the bug.
    // `test: {` ... `exclude` ... `coverage: {` — the discovery exclude must appear BEFORE the
    // coverage block, i.e. on the `test` object itself.
    const testBlock = configSource.indexOf("test: {");
    const coverageBlock = configSource.indexOf("coverage: {");
    expect(testBlock).toBeGreaterThan(-1);
    expect(coverageBlock).toBeGreaterThan(testBlock);

    const betweenTestAndCoverage = configSource.slice(testBlock, coverageBlock);
    expect(betweenTestAndCoverage).toMatch(/exclude:\s*testExclude/);
  });

  it("sources the discovery excludes from the shared vitest.excludes module", () => {
    expect(configSource).toMatch(/import\s*\{[^}]*testExclude[^}]*\}\s*from\s*"\.\/vitest\.excludes"/);
  });
});
