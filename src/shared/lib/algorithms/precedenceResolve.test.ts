// The executable spec for the `precedence-resolve.ts` graph node (#3465). It imports and RUNS the same
// module whose text the graph ships as that node's `code`, so "this implementation works" is observed
// rather than asserted.
import { describe, it, expect, vi } from "vitest";
import { resolveByPrecedence, matchingPrecedence, type PrecedenceRule } from "./precedenceResolve";

/** The Fleet worker case this was harvested from, as a generic subject. */
interface Signals { asking: boolean; waiting: boolean; blocked: boolean; running: boolean; parked: boolean }
type Status = "asking" | "waiting" | "blocked" | "running" | "maintenance";

const RULES: PrecedenceRule<Signals, Status>[] = [
  { state: "asking", when: (s) => s.asking },
  { state: "waiting", when: (s) => s.waiting },
  { state: "blocked", when: (s) => s.blocked },
  { state: "running", when: (s) => s.running },
  { state: "maintenance", when: (s) => s.parked },
];

const NONE: Signals = { asking: false, waiting: false, blocked: false, running: false, parked: false };

describe("resolveByPrecedence", () => {
  it("resolves the first claiming rule, in declared order", () => {
    expect(resolveByPrecedence({ ...NONE, running: true }, RULES, "idle" as const)).toBe("running");
    expect(resolveByPrecedence({ ...NONE, waiting: true }, RULES, "idle" as const)).toBe("waiting");
  });

  it("an EARLIER rule wins over a later one — the property the order exists for", () => {
    // A worker that is both asking a question and mechanically "running" must read `asking`: the whole
    // reason the order is declared is that a state needing a human is never hidden behind a busy one.
    const both: Signals = { ...NONE, asking: true, running: true };
    expect(resolveByPrecedence(both, RULES, "idle" as const)).toBe("asking");
  });

  it("falls back when nothing claims the subject", () => {
    expect(resolveByPrecedence(NONE, RULES, "idle" as const)).toBe("idle");
    expect(resolveByPrecedence(NONE, [], "idle" as const)).toBe("idle");
  });

  it("is LAZY — a predicate below the winner is never called", () => {
    // Not a micro-optimisation: it means an expensive or side-effecting source can sit low in the order
    // without being paid for, which is what makes the order safe to extend.
    const expensive = vi.fn(() => true);
    const rules: PrecedenceRule<Signals, Status>[] = [
      { state: "asking", when: () => true },
      { state: "running", when: expensive },
    ];
    expect(resolveByPrecedence(NONE, rules, "idle" as const)).toBe("asking");
    expect(expensive).not.toHaveBeenCalled();
  });
});

describe("matchingPrecedence", () => {
  it("returns EVERY claiming state in order, not just the winner", () => {
    const both: Signals = { ...NONE, asking: true, running: true, parked: true };
    expect(matchingPrecedence(both, RULES)).toEqual(["asking", "running", "maintenance"]);
  });

  it("is empty when nothing claims — and agrees with the resolver about the winner", () => {
    expect(matchingPrecedence(NONE, RULES)).toEqual([]);
    const s: Signals = { ...NONE, blocked: true, running: true };
    expect(matchingPrecedence(s, RULES)[0]).toBe(resolveByPrecedence(s, RULES, "idle" as const));
  });
});
