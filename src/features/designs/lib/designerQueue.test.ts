import { describe, it, expect } from "vitest";
import { parseCoverage, parseResolve, buildDesignerQueue } from "./designerQueue";

describe("parseCoverage (#3311)", () => {
  it("parses a real-shaped coverage report and drops malformed rows", () => {
    const r = parseCoverage({
      leakCandidates: [{ file: "a/Btn.tsx", count: 3 }, { file: "bad" }],
      zeroConsumers: ["--x", 5],
      components: [{ component: "Btn", tokensConsumed: 2, tokensTotal: 5 }, { component: "bad" }],
    });
    expect(r).not.toBeNull();
    expect(r!.leakCandidates).toEqual([{ file: "a/Btn.tsx", count: 3 }]); // the { file } row (no count) is dropped
    expect(r!.zeroConsumers).toEqual(["--x"]); // the non-string is dropped
    expect(r!.components).toEqual([{ component: "Btn", tokensConsumed: 2, tokensTotal: 5 }]);
  });

  it("returns null for anything that isn't a coverage report", () => {
    expect(parseCoverage(null)).toBeNull();
    expect(parseCoverage("nope")).toBeNull();
    expect(parseCoverage({ error: "boom" })).toBeNull();
  });
});

describe("parseResolve (#3311)", () => {
  it("parses themeMisses + uncontracted (+ drops non-strings)", () => {
    const r = parseResolve({ theme: "nord", themeMisses: ["--card-bg"], uncontracted: ["--x", 1], complete: false });
    expect(r).toEqual({ theme: "nord", themeMisses: ["--card-bg"], uncontracted: ["--x"], complete: false });
  });

  it("returns null when it isn't a resolve reply", () => {
    expect(parseResolve({ foo: 1 })).toBeNull();
    expect(parseResolve(42)).toBeNull();
  });
});

describe("buildDesignerQueue (#3311)", () => {
  it("ranks objective findings first, then motion, then polish", () => {
    const q = buildDesignerQueue({
      coverage: {
        leakCandidates: [{ file: "Btn.tsx", count: 2 }],
        zeroConsumers: ["--dead"],
        components: [{ component: "Btn", tokensConsumed: 1, tokensTotal: 3 }],
      },
      resolve: { theme: "nord", themeMisses: ["--card-bg"], uncontracted: ["--x"] },
      components: [{ id: "c1", name: "Button", role: "control" }],
    });
    const kinds = q.map((d) => d.kind);
    // leak → uncontracted → theme-miss → low-coverage → dead-token, THEN motion, THEN the polish set.
    expect(kinds.slice(0, 5)).toEqual(["leak", "uncontracted", "theme-miss", "low-coverage", "dead-token"]);
    expect(kinds).toContain("motion");
    expect(kinds.filter((k) => k === "polish")).toHaveLength(4);
    // The leak is the very first directive (the highest-priority, demonstrably-ungoverned gap).
    expect(q[0].kind).toBe("leak");
    expect(q[0].target).toBe("Btn.tsx");
  });

  it("drains to only polish when there are no findings and no components (a clean, finite end)", () => {
    const q = buildDesignerQueue({});
    expect(q.every((d) => d.kind === "polish")).toBe(true);
    expect(q).toHaveLength(4);
  });

  it("emits low-coverage only when consumed < total, and skips pages for motion", () => {
    const q = buildDesignerQueue({
      coverage: { leakCandidates: [], zeroConsumers: [], components: [{ component: "Full", tokensConsumed: 3, tokensTotal: 3 }] },
      components: [
        { id: "p", name: "HomePage", role: "page" },
        { id: "b", name: "Btn", role: "control" },
      ],
    });
    expect(q.some((d) => d.kind === "low-coverage")).toBe(false); // fully covered ⇒ no directive
    expect(q.filter((d) => d.kind === "motion").map((d) => d.target)).toEqual(["Btn"]); // page skipped
  });

  it("is pure — the same input yields the same directive ids", () => {
    const inp = { resolve: { themeMisses: ["--a"], uncontracted: [] } };
    expect(buildDesignerQueue(inp).map((d) => d.id)).toEqual(buildDesignerQueue(inp).map((d) => d.id));
  });

  it("rotates motion + polish by round so a long run varies rather than repeating", () => {
    const comps = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
    const r0 = buildDesignerQueue({ components: comps, round: 0 }).filter((d) => d.kind === "motion").map((d) => d.target);
    const r1 = buildDesignerQueue({ components: comps, round: 1 }).filter((d) => d.kind === "motion").map((d) => d.target);
    expect(r0).toEqual(["A", "B", "C"]);
    expect(r1).toEqual(["B", "C", "A"]); // rotated left by one
  });
});
