// The SCALAR / accumulate trace-programs (#3220) — fibonacci computes the RIGHT number (so the animation
// is faithful to the real recurrence), drives the scalar verbs the ScalarView binds to, and its variables
// roll forward exactly as the seeded fibonacci.rs / fibonacci.ts impls do.
import { describe, it, expect } from "vitest";
import { TracedScalar } from "../../lib/tracer";
import type { ScalarFrame } from "../../lib/trace";
import { fibonacci, SCALAR_PROGRAMS, parseScalarInput, scalarToText } from "./scalarAlgos";
import { programVizForImpl } from "./registry";

/** Run fibonacci for `n` and return its recorded trace. */
function run(n: number): ScalarFrame[] {
  const s = new TracedScalar({ n });
  fibonacci(s);
  return s.trace();
}

const last = <T>(a: readonly T[]): T => a[a.length - 1];
const result = (n: number) => last(run(n)).values.fib;
const verbs = (frames: ScalarFrame[]) => frames.flatMap((f) => Object.values(f.ops ?? {})).map((o) => o.op);

/** F0…F12, the reference the trace must reproduce. */
const FIB = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];

describe("fibonacci trace-program (#3220) — correctness", () => {
  it("lands the right F(n) for every n, base cases included", () => {
    for (let n = 0; n < FIB.length; n++) expect(result(n), `F(${n})`).toBe(FIB[n]);
  });

  it("holds for a larger n too (the loop, not a lookup)", () => {
    expect(result(30)).toBe(832040);
    expect(result(40)).toBe(102334155);
  });

  it("a non-numeric / absent n degrades to 0 rather than emitting NaN frames", () => {
    const s = new TracedScalar({});
    fibonacci(s);
    expect(last(s.trace()).values.fib).toBe(0);
    const t = new TracedScalar({ n: "abc" });
    fibonacci(t);
    expect(last(t.trace()).values.fib).toBe(0);
  });
});

describe("the scalar op vocabulary (#3220)", () => {
  it("drives the recurrence with the ACCUMULATE verb — `b += a` is an `add`, the roll-forward a `set`", () => {
    const v = verbs(run(10));
    expect(v).toContain("add");
    expect(v).toContain("set");
    // One `add` per iteration i = 2…n — the recurrence fires exactly n-1 times.
    expect(v.filter((o) => o === "add")).toHaveLength(9);
  });

  it("every op is keyed by the VARIABLE it touched (the scalar frame's per-name op map)", () => {
    for (const f of run(8)) {
      for (const [name, op] of Object.entries(f.ops ?? {})) {
        expect(Object.keys(f.values)).toContain(name);
        expect(["set", "add", "compare"]).toContain(op.op);
      }
    }
  });

  it("the running variables stay CONSISTENT — each settled a/b is a real consecutive Fibonacci pair", () => {
    // An iteration settles on the `set` of `a` (b has already accumulated), leaving a = F(i-1), b = F(i).
    const settled = run(12).filter((f) => f.ops?.a?.op === "set" && typeof f.values.i === "number");
    expect(settled).toHaveLength(11); // i = 2…12
    for (const f of settled) {
      const i = f.values.i as number;
      expect([f.values.a, f.values.b], `after step ${i}`).toEqual([FIB[i - 1], FIB[i]]);
    }
  });

  it("the base case is a legitimately SHORT trace (one step), not an empty one", () => {
    const frames = run(1);
    expect(frames.length).toBeGreaterThan(1); // the resting frame + the answer
    expect(last(frames).values.fib).toBe(1);
    expect(verbs(frames)).toEqual(["set"]);
  });

  it("`i` walks 2…n so the ScalarView shows which step is running", () => {
    const steps = run(7)
      .map((f) => f.values.i)
      .filter((v): v is number => typeof v === "number");
    expect([...new Set(steps)]).toEqual([2, 3, 4, 5, 6, 7]);
  });
});

describe("SCALAR_PROGRAMS + the input seam (#3220)", () => {
  it("registers fibonacci by base name — the key both seeded impls (fibonacci.rs / .ts) resolve to", () => {
    expect(SCALAR_PROGRAMS.fibonacci.run).toBe(fibonacci);
    expect(SCALAR_PROGRAMS.fibonacci.defaultInput.n).toBe(10);
  });

  it("parseScalarInput round-trips scalarToText", () => {
    expect(parseScalarInput(scalarToText(SCALAR_PROGRAMS.fibonacci.defaultInput))).toEqual({ n: 10 });
    expect(parseScalarInput(" 7 ")).toEqual({ n: 7 });
    expect(parseScalarInput("0")).toEqual({ n: 0 });
  });

  it("parseScalarInput rejects bad n with a helpful message", () => {
    expect(() => parseScalarInput("   ")).toThrow(/enter n/i);
    expect(() => parseScalarInput("abc")).toThrow(/"abc" is not a number/);
    expect(() => parseScalarInput("-3")).toThrow(/whole number/i);
    expect(() => parseScalarInput("2.5")).toThrow(/whole number/i);
    expect(() => parseScalarInput("41")).toThrow(/40 or less/i);
  });
});

describe("the seeded fibonacci impls now resolve a visualization (#3220)", () => {
  it("BOTH fibonacci.rs and fibonacci.ts animate on the ScalarView (one algorithm, two impls)", () => {
    for (const id of ["fibonacci.rs", "fibonacci.ts"]) {
      const viz = programVizForImpl({ id });
      expect(viz, id).toBeDefined();
      expect(viz!.renderers.scalar, id).toBeDefined();
      const frames = [...viz!.factory()] as ScalarFrame[];
      expect(last(frames).values.fib, id).toBe(55); // F(10), the default seed
    }
  });

  it("its 'your input' seam re-runs the SAME recurrence on the user's n", async () => {
    const viz = programVizForImpl({ id: "fibonacci.rs" })!;
    const factory = await viz.input.make(viz.input.parse("12"));
    expect(last([...factory()] as ScalarFrame[]).values.fib).toBe(144);
  });
});
