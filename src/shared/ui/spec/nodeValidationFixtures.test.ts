// The TypeScript half of the CROSS-LANGUAGE validation guard (#3485).
//
// `schema.ts` has long asserted, in prose, that "a spec that passes here passes there" — that the TS
// validator and `bsc ui validate` enforce the same contract. With one implementation that was a safe
// comment. With TWO independent implementations in different languages it is a claim that has to be
// TESTED, because two validators drifting apart is worse than one: callers trust the agreement exactly
// where it is most likely to quietly break.
//
// So both sides run THESE fixtures. This file is the TS runner; `crates/bsc-ui` has the Rust twin
// reading the same JSON. A case added here is automatically enforced on both sides.
import { describe, it, expect } from "vitest";
import FIXTURES from "@data/ui/node-validation.fixtures.json";
import { validateGeneralNode } from "./generalNode";

interface Case {
  name: string;
  node: unknown;
  count: number;
  contains: string[];
}

const CASES = (FIXTURES as { cases: Case[] }).cases;

describe("shared node-validation fixtures — TypeScript side (#3485)", () => {
  it("has fixtures at all (a silently-empty set would make this guard vacuous)", () => {
    expect(CASES.length).toBeGreaterThan(10);
  });

  for (const c of CASES) {
    it(c.name, () => {
      const errors = validateGeneralNode(c.node);
      expect(errors, `expected ${c.count} error(s), got: ${JSON.stringify(errors)}`).toHaveLength(c.count);
      for (const needle of c.contains) {
        expect(
          errors.some((e) => e.includes(needle)),
          `no error contained "${needle}" — got: ${JSON.stringify(errors)}`,
        ).toBe(true);
      }
    });
  }
});
