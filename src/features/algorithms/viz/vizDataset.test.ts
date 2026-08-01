import { describe, it, expect } from "vitest";
import { vizRunToDataset } from "./vizDataset";
import type { VizRun } from "./examples/vizProgram";

describe("vizRunToDataset (#2940)", () => {
  it("array: takes the LAST snapshot frame (the sorted output), not the input", () => {
    const run = {
      datatype: "array",
      input: [3, 1, 2],
      frames: [
        { structure: "array", data: [3, 1, 2] },
        { structure: "array", data: [1, 2, 3] }, // settled
      ],
    } as unknown as VizRun;
    expect(vizRunToDataset(run)).toEqual({ kind: "array", data: [1, 2, 3] });
  });

  it("matrix: takes the last snapshot (the transformed grid), deep-copied", () => {
    const run = {
      datatype: "matrix",
      input: [[1, 2], [3, 4]],
      frames: [{ structure: "matrix", data: [[1, 3], [2, 4]] }], // transposed
    } as unknown as VizRun;
    const ds = vizRunToDataset(run);
    expect(ds).toEqual({ kind: "matrix", data: [[1, 3], [2, 4]] });
    // deep copy — mutating the result must not touch the frame
    if (ds?.kind === "matrix") ds.data[0][0] = 99;
    expect((run.frames[0] as { data: number[][] }).data[0][0]).toBe(1);
  });

  it("graph: takes the last snapshot's positioned nodes (the layout output)", () => {
    const run = {
      datatype: "graph",
      input: { nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] },
      frames: [
        { structure: "graph", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] },
        { structure: "graph", nodes: [{ id: "a", x: 10, y: 20 }, { id: "b", x: 30, y: 40 }], edges: [{ from: "a", to: "b" }] },
      ],
    } as unknown as VizRun;
    expect(vizRunToDataset(run)).toEqual({
      kind: "graph",
      nodes: [{ id: "a", x: 10, y: 20 }, { id: "b", x: 30, y: 40 }],
      edges: [{ from: "a", to: "b" }],
    });
  });

  it("scene datatype maps to a graph dataset", () => {
    const run = {
      datatype: "scene",
      input: { nodes: [{ id: "n" }], edges: [] },
      frames: [{ structure: "graph", nodes: [{ id: "n", x: 1, y: 2 }], edges: [] }],
    } as unknown as VizRun;
    expect(vizRunToDataset(run)).toMatchObject({ kind: "graph", nodes: [{ id: "n", x: 1, y: 2 }] });
  });

  it("falls back to the seed input when a run recorded no snapshot frames", () => {
    const arr = { datatype: "array", input: [5, 6], frames: [] } as unknown as VizRun;
    expect(vizRunToDataset(arr)).toEqual({ kind: "array", data: [5, 6] });
    const g = { datatype: "graph", input: { nodes: [{ id: "x" }], edges: [] }, frames: [] } as unknown as VizRun;
    expect(vizRunToDataset(g)).toEqual({ kind: "graph", nodes: [{ id: "x" }], edges: [] });
  });

  // #4162 — the datatypes added alongside the stored-vizCode contract.
  it("tree datatype nests the parent pointers into a forest", () => {
    const run = {
      datatype: "tree",
      input: [50, 30, 70],
      frames: [
        { structure: "tree", nodes: [{ id: "n0", value: 50 }] },
        {
          structure: "tree",
          nodes: [
            { id: "n0", value: 50 },
            { id: "n1", value: 30, parent: "n0" },
            { id: "n2", value: 70, parent: "n0" },
          ],
        },
      ],
    } as unknown as VizRun;
    expect(vizRunToDataset(run)).toEqual({
      kind: "tree",
      roots: [{ id: "n0", label: "50", children: [{ id: "n1", label: "30" }, { id: "n2", label: "70" }] }],
    });
  });

  it("tree: an orphaned node is promoted to a root, never dropped", () => {
    // A partial tree is still worth showing; losing a node would misrepresent what the algorithm did.
    const run = {
      datatype: "tree",
      input: [1],
      frames: [{ structure: "tree", nodes: [{ id: "a", value: 1 }, { id: "b", value: 2, parent: "gone" }] }],
    } as unknown as VizRun;
    expect(vizRunToDataset(run)).toEqual({
      kind: "tree",
      roots: [{ id: "a", label: "1" }, { id: "b", label: "2" }],
    });
  });

  it("stack / scalar have NO bindable dataset rather than a coerced one", () => {
    // A stack holds a mixed number/string sequence and a scalar run is a NAMED variable map — neither is
    // one of the three dataset shapes. Coercing them to `array` would hand a component a plausible-looking
    // dataset that means something else.
    const stack = {
      datatype: "stack",
      input: "([)",
      frames: [{ structure: "stack", data: ["(", "["] }],
    } as unknown as VizRun;
    const scalar = {
      datatype: "scalar",
      input: { n: 5 },
      frames: [{ structure: "scalar", values: { n: 5, fib: 5 } }],
    } as unknown as VizRun;
    expect(vizRunToDataset(stack)).toBeUndefined();
    expect(vizRunToDataset(scalar)).toBeUndefined();
  });
});
