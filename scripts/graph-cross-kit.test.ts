// Cross-kit agreement — the glue that lets one vector drive two languages.
//
// The runner's own failure mode is the quiet one: if the harness or the comparison is wrong, the check
// reports agreement it never established. So the shape-handling and the comparison are pinned here,
// and the fixture itself is validated — a contract nobody checks is a contract that rots.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rustHarness, rustArgs, parseRustOut, callTs, sameResult } from "./graph-cross-kit.mjs";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "src", "features", "algorithms", "lib", "crossKit.fixtures.json"), "utf8"),
);

describe("the rust harness", () => {
  it("passes a list for a sort and prints it back comma-separated", () => {
    const h = rustHarness("sort", "bubble_sort");
    expect(h).toContain("bubble_sort(&a)");
    expect(h).toContain("join(\",\")");
  });

  /** The declared convention: Rust's Option::None becomes -1, matching what TypeScript returns. */
  it("maps a Rust Option miss onto the -1 the fixture declares", () => {
    expect(rustHarness("search", "binary_search")).toContain("unwrap_or(-1)");
  });

  it("refuses a kind it does not know, rather than emitting something that will not compile", () => {
    expect(() => rustHarness("matrix", "f")).toThrow(/unknown fixture kind/);
    expect(() => rustArgs("matrix", {})).toThrow(/unknown fixture kind/);
  });
});

describe("argument and result marshalling", () => {
  it("sends a sort its list and a search its list plus target", () => {
    expect(rustArgs("sort", { input: [3, 1, 2] })).toEqual(["3,1,2"]);
    expect(rustArgs("search", { input: [1, 2], target: 2 })).toEqual(["1,2", "2"]);
    expect(rustArgs("scalar", { input: 10 })).toEqual(["10"]);
  });

  /** An empty sort result prints as an empty line — which must parse to [], not [NaN]. */
  it("parses an empty sort result as an empty array", () => {
    expect(parseRustOut("sort", "\n")).toEqual([]);
    expect(parseRustOut("sort", "1,2,3\n")).toEqual([1, 2, 3]);
    expect(parseRustOut("search", "-1\n")).toBe(-1);
  });

  it("calls each kit's function with the arity its kind implies", () => {
    expect(callTs("sort", (a: number[]) => a.length, { input: [1, 2, 3] })).toBe(3);
    expect(callTs("search", (_a: number[], t: number) => t, { input: [1], target: 9 })).toBe(9);
    expect(callTs("scalar", (n: number) => n * 2, { input: 21 })).toBe(42);
  });
});

describe("sameResult", () => {
  it("compares arrays elementwise and scalars directly", () => {
    expect(sameResult([1, 2], [1, 2])).toBe(true);
    expect(sameResult([1, 2], [2, 1])).toBe(false);
    expect(sameResult([], [])).toBe(true);
    expect(sameResult(5, 5)).toBe(true);
    expect(sameResult(-1, 0)).toBe(false);
  });

  /** A scalar must never compare equal to an array — that would let a shape bug read as agreement. */
  it("never calls an array equal to a scalar", () => {
    expect(sameResult([1], 1)).toBe(false);
    expect(sameResult(1, [1])).toBe(false);
  });
});

describe("the fixture itself", () => {
  it("names both kits and at least one case for every concept", () => {
    expect(fixture.concepts.length).toBeGreaterThan(0);
    for (const c of fixture.concepts) {
      expect(c.rust, `${c.concept} names a rust record`).toMatch(/\.rs$/);
      expect(c.typescript, `${c.concept} names a typescript record`).toMatch(/\.ts$/);
      expect(["sort", "search", "scalar"]).toContain(c.kind);
      expect(c.cases.length, `${c.concept} has cases`).toBeGreaterThan(0);
    }
  });

  /** Edge cases are where two implementations part company, so the vector must actually carry them. */
  it("covers the empty and single-element cases for every sort", () => {
    for (const c of fixture.concepts.filter((x: { kind: string }) => x.kind === "sort")) {
      const inputs = c.cases.map((k: { input: number[] }) => k.input);
      expect(inputs.some((i: number[]) => i.length === 0), `${c.concept} covers empty`).toBe(true);
      expect(inputs.some((i: number[]) => i.length === 1), `${c.concept} covers single`).toBe(true);
      expect(inputs.some((i: number[]) => i.some((n) => n < 0)), `${c.concept} covers negatives`).toBe(true);
    }
  });

  it("covers a MISS for every search, since that is where the two kits' conventions differ", () => {
    for (const c of fixture.concepts.filter((x: { kind: string }) => x.kind === "search")) {
      expect(c.cases.some((k: { expected: number }) => k.expected === -1), `${c.concept} covers a miss`).toBe(true);
    }
  });

  /** The gaps are a decision, and a decision with no reason recorded decays into an oversight. */
  it("records WHY each uncovered shared concept is uncovered", () => {
    expect(fixture.notComparable.graph.reason).toMatch(/adjacency|incompatible/i);
    expect(fixture.notComparable.falseMatch.concepts).toContain("rotate");
    expect(fixture.notComparable.falseMatch.reason).toMatch(/not the same concept/i);
  });
});
