// What `matchGlob` actually means, captured from the LIVE TypeScript so the Rust matcher can be
// measured against it.
//
// TWO ENGINES DECIDE ONE WRITE SCOPE. `write-scope.ts`'s `matchGlob` compiles a glob to a RegExp;
// `bsc_util::scope`'s `fnmatch` is a hand-written POSIX-style matcher. The `bsc-scope` hook ENFORCES
// writes with the Rust one, while the role model, the launch write-rules and the warden's
// conformance check all reason with this one. Nothing binds them.
//
// This file is the measurement, not a claim: it records what the TypeScript does for pairs chosen to
// separate the two readings, and the Rust side asserts against it. A disagreement is a finding.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/globSemantics.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { matchGlob } from "@/shared/lib/session/writeScope";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/globSemantics.fixtures.json");

/** Each pair is chosen to separate the two readings, not to be representative traffic. */
const PAIRS: Array<[string, string, string]> = [
  // [why it is here, glob, path]
  ["plain literal", "src/a.ts", "src/a.ts"],
  ["literal miss", "src/a.ts", "src/b.ts"],
  ["* within one segment", "src/*.ts", "src/a.ts"],
  ["* ACROSS a separator — the security case", "src/*.ts", "src/a/b.ts"],
  ["* across two separators", "src/*.ts", "src/a/b/c.ts"],
  ["** across a separator", "src/**/*.ts", "src/a/b.ts"],
  ["** at the tail", "src/**", "src/a/b/c.ts"],
  ["** matching nothing", "src/**", "src/"],
  ["* does not escape the prefix", "src/*.ts", "lib/a.ts"],
  ["anchoring — no prefix match", "src/a.ts", "x/src/a.ts"],
  ["anchoring — no suffix match", "src/a.ts", "src/a.tsx"],
  ["? as a wildcard or a literal", "src/a?.ts", "src/ab.ts"],
  ["? against a literal question mark", "src/a?.ts", "src/a?.ts"],
  // If `?` is LITERAL these are false; if it is a REGEX QUANTIFIER leaking through the compiler
  // (`a?` = optional 'a') the first is true. That distinction is the difference between a missing
  // feature and an unescaped metacharacter in a security predicate.
  ["? as a leaked regex quantifier — 'a' absent", "src/a?.ts", "src/.ts"],
  ["? as a leaked regex quantifier — 'a' present", "src/a?.ts", "src/a.ts"],
  ["unescaped alternation leaks too?", "src/a|b.ts", "src/a"],
  ["bracket class or literal brackets", "src/[ab].ts", "src/a.ts"],
  ["bracket against literal brackets", "src/[ab].ts", "src/[ab].ts"],
  ["dot is not a wildcard", "src/a.ts", "src/axts"],
  ["plus is literal", "src/a+.ts", "src/a+.ts"],
  ["parens are literal", "src/(a).ts", "src/(a).ts"],
  ["dollar is literal", "src/a$.ts", "src/a$.ts"],
  ["contracts glob from a real capability", "contracts/**/*.json", "contracts/x/y.json"],
  ["real capability glob, one level", "src/**/*.tsx", "src/app/Thing.tsx"],
  ["real capability glob, zero levels", "src/**/*.tsx", "src/Thing.tsx"],
];

function build() {
  return {
    note: "GENERATED from the live TypeScript matchGlob — see globSemantics.fixtures.gen.test.ts",
    pairs: PAIRS.map(([why, glob, path]) => ({ why, glob, path, matches: matchGlob(glob, path) })),
  };
}

describe("what matchGlob means is captured for the Rust matcher to be measured against", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("contains both matches and non-matches, or it separates nothing", () => {
    const m = build().pairs;
    expect(m.some((p) => p.matches)).toBe(true);
    expect(m.some((p) => !p.matches)).toBe(true);
  });
});
