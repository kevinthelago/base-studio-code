// The executable spec for the `order-by-rank.ts` graph node (#3465) — imports and RUNS the module.
import { describe, it, expect } from "vitest";
import { orderByRank } from "./orderByRank";

type State = "blocked" | "running" | "green" | "draft";
// The Fleet merge-queue attention order this was harvested from: failing-but-ready first, drafts last.
const ATTENTION: State[] = ["blocked", "running", "green", "draft"];

interface Row { id: string; state: State }
const rows = (...specs: [string, State][]): Row[] => specs.map(([id, state]) => ({ id, state }));

describe("orderByRank", () => {
  it("orders by the DECLARED priority, not the category's natural order", () => {
    const out = orderByRank(rows(["a", "draft"], ["b", "blocked"], ["c", "green"], ["d", "running"]), (r) => r.state, ATTENTION);
    expect(out.map((r) => r.id)).toEqual(["b", "d", "c", "a"]); // blocked, running, green, draft
  });

  it("is STABLE — items of equal rank keep their input order", () => {
    const out = orderByRank(rows(["x", "green"], ["y", "green"], ["z", "green"]), (r) => r.state, ATTENTION);
    expect(out.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("sorts an UNRANKED category after every ranked one, not to the top", () => {
    // The trap the magic-number version falls into: a category the ranking forgot maps to `undefined`,
    // which as `?? 0` would jump the queue. Unranked means "no stated priority", so it goes last.
    const out = orderByRank(
      rows(["known", "running"], ["mystery", "unknown-state" as State]),
      (r) => r.state,
      ATTENTION,
    );
    expect(out.map((r) => r.id)).toEqual(["known", "mystery"]);
  });

  it("keeps multiple unranked items in input order among themselves", () => {
    const out = orderByRank(
      rows(["a", "zzz" as State], ["b", "green"], ["c", "yyy" as State]),
      (r) => r.state,
      ATTENTION,
    );
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input", () => {
    const input = rows(["a", "draft"], ["b", "blocked"]);
    const snapshot = input.map((r) => r.id);
    orderByRank(input, (r) => r.state, ATTENTION);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });

  it("returns [] for empty input", () => {
    expect(orderByRank([], (r: Row) => r.state, ATTENTION)).toEqual([]);
  });
});
