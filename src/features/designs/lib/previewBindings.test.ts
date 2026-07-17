import { describe, it, expect } from "vitest";
import { bindingFor, adaptDataset, PREVIEW_BINDINGS } from "./previewBindings";
import type { VizDataset } from "@/features/algorithms";

describe("previewBindings — bindingFor (#2940)", () => {
  it("finds the seeded Heatmap←sort.ts exemplar, kit + name case-insensitive", () => {
    const b = bindingFor("react-d3", "heatmap");
    expect(b).toMatchObject({ prop: "data", algorithm: "sort.ts", adapter: "grid" });
    expect(bindingFor("react-d3", "HEATMAP")).toEqual(b); // case-insensitive
  });
  it("returns undefined for an unbound component or wrong kit", () => {
    expect(bindingFor("react-d3", "BarChart")).toBeUndefined();
    expect(bindingFor("react-ui", "heatmap")).toBeUndefined();
  });
  it("the exemplar is the only seeded binding", () => {
    expect(PREVIEW_BINDINGS).toHaveLength(1);
  });
});

describe("previewBindings — adaptDataset (#2940)", () => {
  it("grid: a sorted array becomes a weekly HeatDatum[] (weekday cols, wrapping rows)", () => {
    const ds: VizDataset = { kind: "array", data: [1, 2, 3, 4, 5, 6, 7, 8] };
    const out = adaptDataset(ds, "grid") as { x: string; y: string; value: number }[];
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ x: "mon", y: "0", value: 1 });
    expect(out[6]).toEqual({ x: "sun", y: "0", value: 7 });
    expect(out[7]).toEqual({ x: "mon", y: "1", value: 8 }); // wrapped to the next row
  });

  it("cells: a matrix becomes one HeatDatum per cell (col→x, row→y)", () => {
    const ds: VizDataset = { kind: "matrix", data: [[10, 20], [30, 40]] };
    expect(adaptDataset(ds, "cells")).toEqual([
      { x: "0", y: "0", value: 10 }, { x: "1", y: "0", value: 20 },
      { x: "0", y: "1", value: 30 }, { x: "1", y: "1", value: 40 },
    ]);
  });

  it("graph: passes {nodes,edges} straight through (ForceGraph shape)", () => {
    const ds: VizDataset = { kind: "graph", nodes: [{ id: "a" }], edges: [{ from: "a", to: "a" }] };
    expect(adaptDataset(ds, "graph")).toEqual({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "a" }] });
  });

  it("values: an array passes through", () => {
    expect(adaptDataset({ kind: "array", data: [3, 1, 2] }, "values")).toEqual([3, 1, 2]);
  });

  it("a dataset that doesn't match the adapter returns null (caller falls back to the sample)", () => {
    expect(adaptDataset({ kind: "array", data: [1] }, "graph")).toBeNull();
    expect(adaptDataset({ kind: "graph", nodes: [], edges: [] }, "grid")).toBeNull();
    expect(adaptDataset({ kind: "array", data: [1] }, "cells")).toBeNull();
  });
});
