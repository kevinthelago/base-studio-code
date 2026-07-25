// shapePreview (#3439) — the SHAPE tier: a component declaring a DataShape gets real algorithm data.
import { describe, it, expect } from "vitest";
// Deep, BARREL-FREE import of the real dataset source — importing the `@/features/algorithms` barrel here
// pulls its crossGraphAdapter ↔ designs libraryComposition module-init cycle into the test. previewDataset
// itself imports only pure algorithm leaves, so this path is safe (its own test proves it).
// eslint-disable-next-line no-restricted-imports -- barrel-free path avoids the module-init cycle (#3439)
import { datasetForStructure } from "@/features/algorithms/viz/previewDataset";
import type { VizDataset } from "@/features/algorithms";
import { shapePreviewData, SHAPE_TIER, type DatasetForStructure } from "./shapePreview";
import type { ComponentRecord, PropSpec } from "./model";

const prop = (name: string, type: string): PropSpec => ({ name, type, req: false, desc: "" });
const comp = (over: Partial<ComponentRecord>): ComponentRecord => ({
  id: "c", name: "C", kitId: "react-ui", role: "composite", version: "1.0.0", used: 0,
  tags: [], variants: [], composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "",
  ...over,
});

// A deterministic stub so the RESOLUTION logic is tested without the real algorithm registry.
const STUB: DatasetForStructure = (s): VizDataset =>
  s === "array"
    ? { kind: "array", data: [3, 1, 4, 1, 5] }
    : { kind: "graph", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };

describe("shapePreviewData (#3439)", () => {
  it("fills a list component's array prop with render-safe objects carrying the real value", () => {
    const out = shapePreviewData(comp({ shapes: ["list"], props: [prop("items", "T[]")] }), STUB);
    expect(Object.keys(out)).toEqual(["items"]);
    const items = JSON.parse(out.items) as Array<Record<string, unknown>>;
    expect(items.length).toBe(5);
    // the UNION of fields the real list components read — CollectionItem {id,title} + ActivityItem {login,action,target,repo,createdAt}
    expect(items[0]).toMatchObject({
      id: expect.any(String), title: expect.any(String), login: expect.any(String),
      action: expect.any(String), target: expect.any(String), repo: expect.any(String), createdAt: expect.any(String),
    });
    expect(typeof items[0].value).toBe("number"); // the algorithm-generated value
  });

  it("fills a graph component's nodes + edges arrays (the NetworkPage shape)", () => {
    const out = shapePreviewData(comp({ shapes: ["graph"], props: [prop("nodes", "T[]"), prop("edges", "T[]")] }), STUB);
    expect(Object.keys(out).sort()).toEqual(["edges", "nodes"]);
    const nodes = JSON.parse(out.nodes) as Array<Record<string, unknown>>;
    expect(nodes[0]).toMatchObject({ id: expect.any(String), label: expect.any(String) });
    const edges = JSON.parse(out.edges) as Array<Record<string, unknown>>;
    expect(edges[0]).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  });

  it("fills graph nodes even when there is no edges prop", () => {
    const out = shapePreviewData(comp({ shapes: ["graph"], props: [prop("nodes", "T[]")] }), STUB);
    expect(Object.keys(out)).toEqual(["nodes"]);
  });

  it("falls through for a graph layout with no nodes array (GraphCanvas world:object)", () => {
    expect(shapePreviewData(comp({ shapes: ["graph"], props: [prop("world", "object"), prop("vp", "object")] }), STUB)).toEqual({});
  });

  it("falls through for a list layout with only render props (MasterDetail)", () => {
    expect(shapePreviewData(comp({ shapes: ["list"], props: [prop("rail", "ReactNode"), prop("detail", "ReactNode")] }), STUB)).toEqual({});
  });

  it("falls through cleanly for an unsupported shape (tree #3790 / key-value / linked-list)", () => {
    expect(shapePreviewData(comp({ shapes: ["tree"], props: [prop("nodes", "T[]")] }), STUB)).toEqual({});
    expect(shapePreviewData(comp({ shapes: ["key-value"], props: [prop("items", "T[]")] }), STUB)).toEqual({});
    expect(shapePreviewData(comp({ shapes: ["linked-list"], props: [prop("steps", "T[]")] }), STUB)).toEqual({});
  });

  it("returns {} for a component that declares no shape (leaving samplePropValue to it)", () => {
    expect(shapePreviewData(comp({ props: [prop("items", "T[]")] }), STUB)).toEqual({});
  });

  it("prefers the conventional data prop over an incidental array prop", () => {
    const out = shapePreviewData(comp({ shapes: ["list"], props: [prop("columns", "string[]"), prop("items", "T[]")] }), STUB);
    expect(Object.keys(out)).toEqual(["items"]);
  });

  it("stays fail-soft when the dataset is unavailable (getDataset → undefined)", () => {
    const none: DatasetForStructure = () => undefined;
    expect(shapePreviewData(comp({ shapes: ["list"], props: [prop("items", "T[]")] }), none)).toEqual({});
  });

  // Acceptance: the shape→structure table is asserted against the REAL algorithms registry — a renamed
  // or removed program surfaces here, not as a silently-empty preview.
  it("every SHAPE_TIER structure resolves to a real dataset (registry contract)", () => {
    const entries = Object.values(SHAPE_TIER);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(datasetForStructure(entry!.structure), `structure ${entry!.structure}`).toBeDefined();
    }
  });
});
