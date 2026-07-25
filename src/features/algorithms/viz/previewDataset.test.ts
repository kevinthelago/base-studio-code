// datasetForStructure (#3439) — a sync, real dataset per structure from a canonical trace program.
import { describe, it, expect } from "vitest";
import { datasetForStructure } from "./previewDataset";

describe("datasetForStructure (#3439)", () => {
  it("produces a real array dataset from a canonical sort program", () => {
    const ds = datasetForStructure("array");
    expect(ds?.kind).toBe("array");
    if (ds?.kind !== "array") throw new Error("expected an array dataset");
    expect(ds.data.length).toBeGreaterThan(0);
    expect(ds.data.every((n) => typeof n === "number")).toBe(true);
  });

  it("produces a real graph dataset (nodes + edges) from a canonical traversal", () => {
    const ds = datasetForStructure("graph");
    expect(ds?.kind).toBe("graph");
    if (ds?.kind !== "graph") throw new Error("expected a graph dataset");
    expect(ds.nodes.length).toBeGreaterThan(0);
    expect(ds.nodes[0]).toHaveProperty("id");
    expect(Array.isArray(ds.edges)).toBe(true);
  });

  it("is deterministic across calls — a preview never flickers between renders", () => {
    expect(datasetForStructure("array")).toEqual(datasetForStructure("array"));
    expect(datasetForStructure("graph")).toEqual(datasetForStructure("graph"));
  });
});
