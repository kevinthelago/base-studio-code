// Array SEARCH trace-programs (#3220) — each search is CORRECT (so the animation is faithful to the real
// algorithm), the two produce genuinely different op profiles, and the `probe`/`found` vocabulary behaves:
// a probe is a single-cell verb, and the terminal `found` mark survives as the trace's resting state.
import { describe, it, expect } from "vitest";
import { TracedArray } from "../../lib/tracer";
import { opStateAttrs } from "../../lib/binding";
import type { ArrayFrame, ArrayOp } from "../../lib/trace";
import { linearSearch, binarySearch, SEARCH_PROGRAMS, parseSearchInput, searchToText } from "./searches";
import { programVizForImpl } from "./registry";

type Search = (a: TracedArray, target: number) => number;

/** Run a search over `values` and return BOTH the result and its recorded trace. */
function run(algo: Search, values: number[], target: number): { at: number; frames: ArrayFrame[] } {
  const a = new TracedArray(values);
  const at = algo(a, target);
  return { at, frames: a.trace() };
}

const ops = (frames: ArrayFrame[]): ArrayOp[] => frames.flatMap((f) => f.ops ?? []);
const opSig = (frames: ArrayFrame[]) => ops(frames).map((o) => o.op).join(",");
const last = <T>(a: readonly T[]): T => a[a.length - 1];

const SORTED = [1, 3, 4, 7, 9, 12, 15, 18, 21];
const UNSORTED = [5, 2, 9, 1, 6, 3, 8, 4, 7];

describe("search trace-programs (#3220) — correctness", () => {
  it("linear search finds every present value at its FIRST index, and misses cleanly", () => {
    for (const values of [UNSORTED, [1], [2, 2, 3], []]) {
      for (const target of values) {
        expect(run(linearSearch, values, target).at).toBe(values.indexOf(target));
      }
      expect(run(linearSearch, values, 999).at).toBe(-1);
    }
  });

  it("binary search finds every value in a sorted array, and misses cleanly", () => {
    for (const values of [SORTED, [1], [1, 2], []]) {
      for (const target of values) {
        expect(values[run(binarySearch, values, target).at]).toBe(target);
      }
      expect(run(binarySearch, values, 999).at).toBe(-1);
      expect(run(binarySearch, values, -999).at).toBe(-1);
    }
  });

  it("binary search probes far FEWER cells than linear — the halving is real, not decorative", () => {
    const values = Array.from({ length: 64 }, (_, i) => i * 2); // sorted, 64 cells
    const target = 126; // the last cell — linear's worst case, binary's ~log2(64)
    const bin = ops(run(binarySearch, values, target).frames).filter((o) => o.op === "probe");
    const lin = ops(run(linearSearch, values, target).frames).filter((o) => o.op === "probe");
    expect(lin).toHaveLength(64);
    expect(bin.length).toBeLessThanOrEqual(7); // ⌈log2(65)⌉
  });
});

describe("the search op vocabulary (#3220) — probe + found", () => {
  it("emits `probe` (never the sorts' pairwise `compare`) — a search examines ONE cell", () => {
    const sig = opSig(run(binarySearch, SORTED, 15).frames);
    expect(sig).toContain("probe");
    expect(sig).not.toContain("compare");
    expect(sig).not.toContain("swap");
    expect(sig).not.toContain("set"); // a search never mutates the array
  });

  it("every `probe` addresses a SINGLE in-range index (not an index pair)", () => {
    for (const [algo, values] of [[linearSearch, UNSORTED], [binarySearch, SORTED]] as const) {
      for (const o of ops(run(algo, values, values[4]).frames)) {
        if (o.op !== "probe") continue;
        expect(typeof o.at).toBe("number");
        expect(o.at as number).toBeGreaterThanOrEqual(0);
        expect(o.at as number).toBeLessThan(values.length);
      }
    }
  });

  it("a hit ends on a `found` mark at the hit index — and that marking SURVIVES to the final frame", () => {
    for (const [algo, values, target] of [
      [linearSearch, UNSORTED, 3],
      [binarySearch, SORTED, 15],
    ] as const) {
      const { at, frames } = run(algo, values, target);
      expect(values[at]).toBe(target);
      // The mark is the LAST thing the program emits: nothing runs after it, so no later verb can
      // supersede it (the array twin of the graph roles/marks separation, #3378).
      const terminal = last(frames);
      expect(terminal.ops).toEqual([{ op: "mark", at, as: "found" }]);
      // …and it is the ONLY `found` in the whole trace — a search marks exactly one cell.
      expect(ops(frames).filter((o) => o.op === "mark" && o.as === "found")).toHaveLength(1);
    }
  });

  it("a MISS emits no `found` at all — the trace simply ends on the last probe", () => {
    for (const [algo, values] of [[linearSearch, UNSORTED], [binarySearch, SORTED]] as const) {
      const { at, frames } = run(algo, values, 999);
      expect(at).toBe(-1);
      expect(ops(frames).some((o) => o.op === "mark")).toBe(false);
      expect(last(frames).ops?.[0]?.op).toBe("probe");
    }
  });

  it("`probe` and `found` bind to SEPARATE data-states, so neither clobbers the other on one cell", () => {
    // The renderer stamps a transient op on `data-op` and a durable mark on `data-mark` — the same cell
    // can legitimately carry both in one frame, exactly as a graph node can be both `start` and visited.
    expect(opStateAttrs([{ op: "probe", at: 2 }], 2)).toEqual({ "data-op": "probe" });
    expect(opStateAttrs([{ op: "mark", at: 2, as: "found" }], 2)).toEqual({ "data-mark": "found" });
    expect(opStateAttrs([{ op: "probe", at: 2 }, { op: "mark", at: 2, as: "found" }], 2)).toEqual({
      "data-op": "probe",
      "data-mark": "found",
    });
  });

  it("a search NEVER mutates the array — every frame carries the input unchanged", () => {
    const { frames } = run(binarySearch, SORTED, 15);
    for (const f of frames) expect(f.data).toEqual(SORTED);
  });

  it("the two searches produce different op profiles — not the same animation", () => {
    expect(opSig(run(linearSearch, SORTED, 21).frames)).not.toBe(opSig(run(binarySearch, SORTED, 21).frames));
  });

  it("binary search rides lo/mid/hi cursors so the shrinking window is visible", () => {
    const probed = run(binarySearch, SORTED, 21).frames.filter((f) => f.ops?.some((o) => o.op === "probe"));
    for (const f of probed) expect(Object.keys(f.cursors ?? {}).sort()).toEqual(["hi", "lo", "mid"]);
    // The window really closes in: the first probe's span is wider than the last's.
    const span = (f: ArrayFrame) => (f.cursors!.hi as number) - (f.cursors!.lo as number);
    expect(span(probed[0])).toBeGreaterThan(span(last(probed)));
  });
});

describe("SEARCH_PROGRAMS + the input seam (#3220)", () => {
  it("registers the family keyed by base name (matching the seeded binary-search.rs / linear-search.rs)", () => {
    expect(SEARCH_PROGRAMS["linear-search"].run).toBe(linearSearch);
    expect(SEARCH_PROGRAMS["binary-search"].run).toBe(binarySearch);
  });

  it("each default input actually CONTAINS its target (the shipped preview shows a hit, not a miss)", () => {
    for (const [key, program] of Object.entries(SEARCH_PROGRAMS)) {
      const { values, target } = program.defaultInput;
      expect(values, key).toContain(target);
      expect(run(program.run, values, target).at, key).toBeGreaterThanOrEqual(0);
    }
  });

  it("the binary-search default is SORTED (its precondition), the linear-search default is not", () => {
    const bin = SEARCH_PROGRAMS["binary-search"].defaultInput.values;
    expect(bin).toEqual([...bin].sort((a, b) => a - b));
    const lin = SEARCH_PROGRAMS["linear-search"].defaultInput.values;
    expect(lin).not.toEqual([...lin].sort((a, b) => a - b));
  });

  it("parseSearchInput round-trips searchToText", () => {
    for (const program of Object.values(SEARCH_PROGRAMS)) {
      expect(parseSearchInput(searchToText(program.defaultInput))).toEqual(program.defaultInput);
    }
    expect(parseSearchInput("1 3 5|3")).toEqual({ values: [1, 3, 5], target: 3 });
    expect(parseSearchInput(" -2, 0, 3.5 | -2 ")).toEqual({ values: [-2, 0, 3.5], target: -2 });
  });

  it("parseSearchInput rejects a missing / malformed target with a helpful message", () => {
    expect(() => parseSearchInput("1, 3, 5")).toThrow(/single '\|'/i);
    expect(() => parseSearchInput("1, 3, 5 | 3 | 4")).toThrow(/single '\|'/i);
    expect(() => parseSearchInput("1, 3, 5 |   ")).toThrow(/add the target/i);
    expect(() => parseSearchInput("1, 3, 5 | abc")).toThrow(/"abc" is not a number/);
    expect(() => parseSearchInput("  | 3")).toThrow(/at least one number/i);
  });
});

describe("the seeded search impls now resolve a visualization (#3220)", () => {
  it("binary-search.rs / linear-search.rs animate on the ArrayView, probing from the default input", () => {
    for (const id of ["binary-search.rs", "linear-search.rs"]) {
      const viz = programVizForImpl({ id });
      expect(viz, id).toBeDefined();
      expect(viz!.renderers.array, id).toBeDefined();
      const frames = [...viz!.factory()] as ArrayFrame[];
      expect(ops(frames).some((o) => o.op === "probe"), id).toBe(true);
      expect(last(frames).ops?.[0], id).toMatchObject({ op: "mark", as: "found" });
    }
  });

  it("its 'your input' seam re-runs the SAME search on the user's array + target", async () => {
    const viz = programVizForImpl({ id: "binary-search.rs" })!;
    const factory = await viz.input.make(viz.input.parse("2, 4, 6, 8 | 8"));
    const frames = [...factory()] as ArrayFrame[];
    expect(frames[0].data).toEqual([2, 4, 6, 8]);
    expect(last(frames).ops).toEqual([{ op: "mark", at: 3, as: "found" }]);
  });
});
