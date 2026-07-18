// Regression coverage for #3392 — `scripts/` used to sit outside the gate entirely: tsconfig
// `include` was ["src", …] and the lint script was `eslint src`, so every file here (these tests
// included) was neither typechecked nor linted. A #3379 agent grepped a lint run for its new
// scripts/ files, saw nothing, and read that as clean — it was vacuous.
//
// These assertions are deliberately about the GATE CONFIG rather than about any one file's
// contents: the failure mode being guarded is "the check silently stops covering things", which no
// amount of per-file assertions can catch. They also guard the trap the issue called out — widening
// the CLI scope to `.` without worktree ignores re-introduces the #3379 leak in the linter, since
// flat config does NOT auto-ignore dotdirs and nested worktrees would all be walked.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(repoRoot, rel), "utf8"));

describe("#3392 gate covers scripts/", () => {
  it("typechecks scripts/ (tsconfig include)", () => {
    expect(readJson("tsconfig.json").include).toContain("scripts");
  });

  it("lints scripts/ — the CLI scope is not narrowed back to src", () => {
    const { lint, "lint:fix": lintFix } = readJson("package.json").scripts;
    // `eslint src` (or any scope that omits scripts/) is exactly the regression.
    for (const cmd of [lint, lintFix]) {
      expect(cmd).toMatch(/^eslint \./);
    }
  });
});

describe("#3392 lint scope is safe to widen", () => {
  const config = readFileSync(path.join(repoRoot, "eslint.config.js"), "utf8");

  // Read as text, not by importing: the point is that the PATTERNS are declared. Importing would
  // pull the whole plugin graph in for no extra signal.
  it.each([
    ["nested sibling worktrees", '"**/wt*/**"'],
    ["the .claude/worktrees convention", '"**/.claude/worktrees/**"'],
  ])("ignores %s", (_label, pattern) => {
    expect(config).toContain(pattern);
  });

  it("still lints plain JS/ESM, so scripts/*.mjs are not walked rule-free", () => {
    // Before #3392 the only config block was `**/*.{ts,tsx}`, so the .mjs build/release scripts
    // matched NO block and were checked with zero rules — walked, reported clean, never inspected.
    expect(config).toMatch(/files:\s*\["\*\*\/\*\.\{js,mjs,cjs\}"\]/);
  });
});
