// The executable spec for the `group-totals.ts` graph node (#3465) — imports and RUNS the module.
import { describe, it, expect } from "vitest";
import { groupTotals } from "./groupTotals";

// The Fleet cost case this was harvested from: per-worker token spend, grouped by model.
interface Cost { model: string; tokens: number; usd: number }
const costs = (...xs: [string, number, number][]): Cost[] =>
  xs.map(([model, tokens, usd]) => ({ model, tokens, usd }));

const FIELDS = { tokens: (c: Cost) => c.tokens, usd: (c: Cost) => c.usd };

describe("groupTotals", () => {
  it("totals every field at both the group and grand-total level", () => {
    const out = groupTotals(
      costs(["opus", 100, 3], ["opus", 50, 1], ["haiku", 200, 0.2]),
      (c) => c.model,
      FIELDS,
    );
    expect(out.totals).toEqual({ tokens: 350, usd: 4.2 });
    expect(out.count).toBe(3);

    const byModel = Object.fromEntries(out.groups.map((g) => [g.key, g]));
    expect(byModel.opus.totals).toEqual({ tokens: 150, usd: 4 });
    expect(byModel.opus.count).toBe(2);
    expect(byModel.haiku.totals).toEqual({ tokens: 200, usd: 0.2 });
  });

  it("the group subtotals always sum to the grand total — they come from one pass", () => {
    // The bug this removes: subtotals and grand total summed independently and drifting apart.
    const out = groupTotals(
      costs(["a", 10, 1], ["b", 20, 2], ["a", 30, 3], ["c", 40, 4]),
      (c) => c.model,
      FIELDS,
    );
    for (const field of ["tokens", "usd"] as const) {
      const summed = out.groups.reduce((acc, g) => acc + g.totals[field], 0);
      expect(summed).toBeCloseTo(out.totals[field]);
    }
  });

  it("orders groups by FIRST appearance", () => {
    const out = groupTotals(costs(["z", 1, 0], ["a", 1, 0], ["z", 1, 0], ["m", 1, 0]), (c) => c.model, FIELDS);
    expect(out.groups.map((g) => g.key)).toEqual(["z", "a", "m"]);
  });

  it("empty input ⇒ zero totals, zero count, no groups", () => {
    const out = groupTotals([], (c: Cost) => c.model, FIELDS);
    expect(out).toEqual({ totals: { tokens: 0, usd: 0 }, count: 0, groups: [] });
  });

  it("carries a field that is always zero as a real 0, not a missing key", () => {
    const out = groupTotals(costs(["a", 5, 0]), (c) => c.model, FIELDS);
    expect(out.totals.usd).toBe(0);
    expect(out.groups[0].totals.usd).toBe(0);
  });
});
