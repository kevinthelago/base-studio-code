// A GRAPH FOLD WITH NO CALLER IS A NODE NOBODY SEES — and the folds this file guarded are RETIRED.
//
// This file was written because it happened twice: `surfaceGraph` (slice 1 of
// `epic-command-surfaces-are-nodes`) and then `featureBand`/`featureDrill` each shipped with passing
// tests and no call site, so the node they drew never existed in the running app. It listed the folds a
// component must call (`withSurfaceNodes`, `crateDrillGraph`, `withFeatureNodes`) and derived the rest
// from the exports of the projection modules (`feature-nodes.ts`, `surface-nodes.ts`).
//
// `the-project-drill-is-one-layer-and-every-node-opens-its-session` removed every one of them: the
// maintainer retired the crate and feature sub-layers and the grouping nodes, so streams are the nodes and
// `bsc fleet graph` draws them. `feature-nodes.ts`, `graph-depth.ts` and `surface-spawn.ts` are deleted,
// and `surface-nodes.ts` keeps only the crate-kind vocabulary the legend reads — it projects nothing.
//
// What stays true, and is what this guards now: the retired projections do not come back as exported,
// uncalled code. A projection module that returns needs a call site before it needs a test, and the
// place to write that assertion is here.
import { describe, it, expect } from "vitest";
import { loadStore } from "@scripts/lib/recordStore.mjs";

const store = loadStore() as { implementations: { id: string; code?: string }[] };
const byId = new Map(store.implementations.map((i) => [i.id, i.code ?? ""]));

describe("the retired glance projections stay retired", () => {
  it("reads the committed store at all — an empty scan would pass every assertion below", () => {
    expect(store.implementations.length).toBeGreaterThan(1000);
    expect(byId.has("glance-graph.ts")).toBe(true);
  });

  it.each(["feature-nodes.ts", "graph-depth.ts", "surface-spawn.ts"])("%s is gone from the store", (id) => {
    expect(byId.has(id), `${id} was a sub-layer module; the drill is one layer`).toBe(false);
  });

  it("surface-nodes.ts projects nothing — it exports no function a component would have to call", () => {
    const code = byId.get("surface-nodes.ts") ?? "";
    expect(code, "surface-nodes.ts still holds the crate-kind vocabulary").toContain("CRATE_KIND_ROLE");
    expect([...code.matchAll(/export function (\w+)/g)].map((m) => m[1])).toEqual([]);
  });

  it("no record still exports a retired fold", () => {
    const retired = ["withSurfaceNodes", "crateDrillGraph", "withFeatureNodes", "featureBand", "featureDrill", "liveCrateDrill", "opensSubLayer"];
    for (const [id, code] of byId) {
      for (const fold of retired) {
        expect(code.includes(`function ${fold}(`), `${id} defines retired fold ${fold}`).toBe(false);
      }
    }
  });
});
