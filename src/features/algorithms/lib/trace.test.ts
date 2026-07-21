// The trace-frame contract (#3176) — `normalizeFrame` for a bare frame + a panels frame, `isPanelsFrame`,
// and a few type-level round-trips (each structure's frame narrows on its `structure` discriminant).
import { describe, it, expect } from "vitest";
import {
  normalizeFrame,
  isPanelsFrame,
  type Frame,
  type StructureFrame,
  type ArrayFrame,
  type GraphFrame,
  type MatrixFrame,
  type ScalarFrame,
} from "./trace";

describe("normalizeFrame (#3176)", () => {
  it("wraps a bare single-structure frame under the `main` panel", () => {
    const bare: Frame = { structure: "array", data: [3, 1, 2], ops: [{ op: "swap", at: [0, 1] }] };
    expect(normalizeFrame(bare)).toEqual({ main: bare });
    expect(isPanelsFrame(bare)).toBe(false);
  });

  it("returns a panels frame's own map unchanged", () => {
    const panels = {
      panels: {
        graph: { structure: "graph", nodes: [{ id: "a" }], edges: [] },
        dist: { structure: "array", data: [0, Infinity] },
      },
    } satisfies Frame;
    expect(normalizeFrame(panels)).toEqual(panels.panels);
    expect(isPanelsFrame(panels)).toBe(true);
  });
});

describe("StructureFrame discriminant round-trips (#3176)", () => {
  it("narrows each structure on its `structure` tag and preserves its payload", () => {
    const frames: StructureFrame[] = [
      { structure: "array", data: [1, 2], cursors: { i: 0 }, ops: [{ op: "compare", at: [0, 1] }] },
      { structure: "matrix", data: [[1, 2], [3, 4]], heat: true, ops: [{ op: "write", at: [1, 0] }] },
      {
        structure: "graph",
        nodes: [{ id: "a", value: 0 }, { id: "b" }],
        edges: [{ from: "a", to: "b", weight: 5 }],
        marks: { a: "visited", b: "frontier" },
        roles: { a: "start" }, // the durable anchor rides its own field (#3378) — `a` is both
        ops: [{ op: "relax", edge: ["a", "b"] }],
      },
      { structure: "linked-list", data: [1, 2, 3], doubly: true, ops: [{ op: "relink", from: 0, to: 2 }] },
      {
        structure: "tree",
        nodes: [{ id: "r", value: 10 }, { id: "l", value: 5, parent: "r" }],
        marks: { r: "current" },
        ops: [{ op: "rotate", pivot: "r", dir: "left" }],
      },
      { structure: "table", rows: [{ key: "x", value: 1, bucket: 2 }], buckets: 8, ops: [{ op: "probe", bucket: 2 }] },
      { structure: "stack", data: [1, 2], mode: "queue", ops: [{ op: "push" }, { op: "peek", at: 0 }] },
      { structure: "scalar", values: { sum: 6 }, ops: { sum: { op: "add", delta: 2 } }, timeline: true },
    ];

    // Every frame carries its own tag, and narrowing gives the right payload field.
    for (const f of frames) {
      switch (f.structure) {
        case "array": {
          const a: ArrayFrame = f;
          expect(a.data.length).toBe(2);
          break;
        }
        case "matrix": {
          const m: MatrixFrame = f;
          expect(m.data[0][1]).toBe(2);
          break;
        }
        case "graph": {
          const g: GraphFrame = f;
          expect(g.roles?.a).toBe("start");
          expect(g.marks?.a).toBe("visited");
          break;
        }
        case "scalar": {
          const s: ScalarFrame = f;
          expect(s.values.sum).toBe(6);
          break;
        }
        default:
          expect(f.structure).toBeTruthy();
      }
    }
    expect(frames).toHaveLength(8);
  });
});
