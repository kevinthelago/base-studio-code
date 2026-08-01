import { describe, it, expect } from "vitest";
import { fleetPlanProgress, mergeStreamProgress, unionDone, normalizeRef } from "./fleetPlanProgress";
import type { StreamProgress } from "./streamProgress";

describe("fleetPlanProgress", () => {
  it("THE BUG (#4102): a fleet whose plan.db has no issue rows still reports progress", () => {
    // The live shape that shipped the invisible bars: 40 streams owning 60 refs, and an `issues`
    // table with zero rows. #4050 derived `total` from those rows, so every node got `total: 0` and
    // the node's (correct) `total > 0` guard hid the bar permanently. Ownership comes from the stream.
    const streams = [
      { id: "cli-platform", issues: ["#3898", "#3979"] },
      { id: "console", issues: ["#3871", "#3917", "#3992"] },
    ];
    const out = fleetPlanProgress(streams, new Set(["3898", "3871", "3917"]));
    expect(out.get("cli-platform")).toEqual({ done: 1, total: 2 });
    expect(out.get("console")).toEqual({ done: 2, total: 3 });
  });

  it("a stream owning no issues reports total 0, so the node renders NO bar", () => {
    // Deliberate: an empty bar and a zero-progress bar say different things, and only one is true.
    const out = fleetPlanProgress([{ id: "standing", issues: [] }], new Set(["1"]));
    expect(out.get("standing")).toEqual({ done: 0, total: 0 });
  });

  it("matches refs regardless of the `#` prefix", () => {
    // The refs meet from three places — the plan's strings, plan.db's `ref` column, GitHub's numeric
    // `number`. A formatting mismatch would show as a bar stuck at 0/N.
    const out = fleetPlanProgress([{ id: "s", issues: ["#12", " 13 "] }], new Set(["12", "#13"]));
    expect(out.get("s")).toEqual({ done: 2, total: 2 });
  });

  it("counts a duplicated ref once, so done can never exceed total", () => {
    const out = fleetPlanProgress([{ id: "s", issues: ["#7", "#7"] }], new Set(["7"]));
    expect(out.get("s")).toEqual({ done: 1, total: 1 });
  });

  it("a done ref owned by nobody inflates no one's progress", () => {
    const out = fleetPlanProgress([{ id: "s", issues: ["#1"] }], new Set(["1", "999"]));
    expect(out.get("s")).toEqual({ done: 1, total: 1 });
  });
});

describe("the director's aggregate row (#4122)", () => {
  const streams = [
    { id: "api", issues: ["#1", "#2"] },
    { id: "web", issues: ["#3"] },
    { id: "standing", issues: [] },
  ];

  it("gives the director EVERY stream's issues, not a lane", () => {
    // The director owns no stream, so a per-stream map left its node with no bar at all — even though
    // it is the one agent accountable for the whole board. Measured on the live fleet: 40 streams, and
    // the director now reads 56, the project's entire owned set.
    const out = fleetPlanProgress(streams, new Set(["1"]), "director");
    expect(out.get("director")).toEqual({ done: 1, total: 3 });
  });

  it("de-duplicates a ref two streams both claim", () => {
    // A union, NOT a sum of the per-stream rows: double-counting would make the director's denominator
    // disagree with the work its workers actually own.
    const out = fleetPlanProgress([{ id: "a", issues: ["#7"] }, { id: "b", issues: ["#7"] }], new Set(["7"]), "director");
    expect(out.get("director")).toEqual({ done: 1, total: 1 });
  });

  it("leaves each worker's own lane untouched", () => {
    const out = fleetPlanProgress(streams, new Set(["1"]), "director");
    expect(out.get("api")).toEqual({ done: 1, total: 2 });
    expect(out.get("web")).toEqual({ done: 0, total: 1 });
    expect(out.get("standing")).toEqual({ done: 0, total: 0 });   // owns nothing ⇒ no bar
  });

  it("emits NO aggregate row when the fleet has no director", () => {
    // A fleet without one must not gain a phantom node's worth of progress.
    expect(fleetPlanProgress(streams, new Set()).has("director")).toBe(false);
  });
});

describe("normalizeRef", () => {
  it("strips the prefix and surrounding space, and accepts a number", () => {
    expect(normalizeRef("#3898")).toBe("3898");
    expect(normalizeRef(" 3898 ")).toBe("3898");
    expect(normalizeRef(3898)).toBe("3898");
  });
});

describe("unionDone", () => {
  it("merges every evidence source and normalises as it goes", () => {
    // plan.db knows only what a planner run authored; GitHub only what a token could reach. Either
    // calling a ref finished makes it finished.
    expect([...unionDone(["#1"], new Set(["2"]), undefined)].sort()).toEqual(["1", "2"]);
  });

  it("is empty when every source is", () => {
    expect(unionDone(undefined, [], new Set()).size).toBe(0);
  });
});

describe("mergeStreamProgress", () => {
  const p = (done: number, total: number): StreamProgress => ({ done, total });

  it("does NOT regress a project that plan.db was already answering for", () => {
    // #4050's path: issue rows carry a `stream`, but the stream record lists no refs. That project
    // showed a bar before this change and must still show the same one.
    const fromRefs = new Map([["s", p(0, 0)]]);         // owns no refs
    const fromPlanDb = new Map([["s", p(3, 7)]]);
    expect(mergeStreamProgress(fromRefs, fromPlanDb).get("s")).toEqual(p(3, 7));
  });

  it("prefers the ref-derived numbers when the stream owns refs", () => {
    // The denominator that cannot silently collapse to zero wins.
    const fromRefs = new Map([["s", p(1, 2)]]);
    const fromPlanDb = new Map([["s", p(0, 0)]]);
    expect(mergeStreamProgress(fromRefs, fromPlanDb).get("s")).toEqual(p(1, 2));
  });

  it("keeps streams known to only one source", () => {
    const merged = mergeStreamProgress(new Map([["a", p(1, 1)]]), new Map([["b", p(2, 4)]]));
    expect(merged.get("a")).toEqual(p(1, 1));
    expect(merged.get("b")).toEqual(p(2, 4));
  });
});
