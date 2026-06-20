import { describe, it, expect } from "vitest";
import {
  proposeLayers,
  layersToNodes,
  shapeLayers,
  layerTitle,
  LAYER_ORDER,
  DIMENSIONS,
} from "../screens/planner/data/shaping";

describe("proposeLayers", () => {
  it("always includes the core domain layer, even with no answers", () => {
    expect(proposeLayers({})).toEqual(["domain"]);
  });

  it("pulls in a layer per yes dimension, in canonical order", () => {
    expect(proposeLayers({ ui: true, api: true, datastore: true })).toEqual([
      "presentation",
      "api",
      "domain",
      "data",
    ]);
  });

  it("ignores false / undefined answers", () => {
    expect(proposeLayers({ ui: false, api: true, ml: undefined })).toEqual(["api", "domain"]);
  });

  it("is order-independent in input and dedupes", () => {
    const a = proposeLayers({ infra: true, ui: true });
    const b = proposeLayers({ ui: true, infra: true });
    expect(a).toEqual(b);
    expect(a).toEqual(["presentation", "domain", "infra"]);
  });

  it("every dimension maps to known, ordered layers", () => {
    for (const d of DIMENSIONS) {
      for (const layer of d.layers) {
        expect(LAYER_ORDER).toContain(layer);
      }
    }
  });
});

describe("layersToNodes / shapeLayers", () => {
  it("makes one stub layer node per layer", () => {
    const nodes = layersToNodes(["api", "data"]);
    expect(nodes).toEqual([
      { id: "layer:api", kind: "layer", title: layerTitle("api"), maturity: "stub", children: [] },
      { id: "layer:data", kind: "layer", title: layerTitle("data"), maturity: "stub", children: [] },
    ]);
  });

  it("shapeLayers goes answers -> stub layer nodes", () => {
    const nodes = shapeLayers({ api: true, datastore: true });
    expect(nodes.map((n) => n.id)).toEqual(["layer:api", "layer:domain", "layer:data"]);
    expect(nodes.every((n) => n.kind === "layer" && n.maturity === "stub")).toBe(true);
  });
});
