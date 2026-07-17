// #3242 — the `graph-viz` builtin kit: seeded, stamped, and RECOVERABLE (shadow-proof) via the #2483
// reconcile. Flag-INDEPENDENT (graph-viz seeds regardless of DEFAULT_KIT_SEEDED). Mirrors the algo-viz
// guards (#3194).
import { describe, it, expect } from "vitest";
import type { Kit } from "./model";
import { SEED_KITS, SEED_COMPONENTS, reconcileKits, reconcileComponents } from "./seed";
import { makeGraphVizKit, GRAPH_NODES_ID } from "./graphVizKit";
import { seedHashOf } from "./seedRefresh";
import { looksBuildableModule } from "./componentPreview";
import { GRAPH_VIZ_KIT_ID, GRAPH_VIZ_ANIMATIONS } from "@/shared/ui/kit/graphVizAnimations";

const ANIM_NAMES = GRAPH_VIZ_ANIMATIONS.map((a) => a.name); // ["frontier","visit","relax"]
const graphKit = SEED_KITS.find((k) => k.id === GRAPH_VIZ_KIT_ID)!;
const graphComp = SEED_COMPONENTS.find((c) => c.id === GRAPH_NODES_ID)!;

describe("the graph-viz builtin kit is seeded + stamped (#3242)", () => {
  it("the kit is a seeded builtin with a self-consistent seedHash, carrying the animations (reused, not duplicated)", () => {
    expect(graphKit).toBeDefined();
    expect(graphKit.builtin).toBe(true);
    expect(graphKit.seedHash).toBe(seedHashOf(graphKit));
    expect(graphKit.animations?.map((a) => a.name)).toEqual(ANIM_NAMES);
    // Reuses the SHARED animation DATA by reference — one definition, two consumers (the GraphView
    // renderer + this kit); a copy would silently drift.
    expect(graphKit.animations).toBe(GRAPH_VIZ_ANIMATIONS);
  });

  it("the demo component is a seeded builtin bound to the animation names, with a buildable preview source", () => {
    expect(graphComp).toBeDefined();
    expect(graphComp.builtin).toBe(true);
    expect(graphComp.kitId).toBe(GRAPH_VIZ_KIT_ID);
    expect(graphComp.seedHash).toBe(seedHashOf(graphComp));
    expect(graphComp.animations).toEqual(ANIM_NAMES);
    expect(looksBuildableModule(graphComp.srcText)).toBe(true);
  });

  it("makeGraphVizKit is deterministic (stable seedHash across assemblies — no spurious re-seed)", () => {
    const a = makeGraphVizKit();
    const b = makeGraphVizKit();
    expect(a.kits[0].seedHash).toBe(b.kits[0].seedHash);
    expect(a.components[0].seedHash).toBe(b.components[0].seedHash);
    expect(a.kits[0].seedHash).toBe(graphKit.seedHash);
  });
});

describe("recover / shadow-proof: a store lacking graph-viz re-adds it (#3242 via #2483)", () => {
  it("an EMPTY store gets the kit + component appended AND pushed through the bridge", () => {
    const rk = reconcileKits([]);
    expect(rk.records.some((k) => k.id === GRAPH_VIZ_KIT_ID)).toBe(true);
    expect(rk.pushes.some((k) => k.id === GRAPH_VIZ_KIT_ID)).toBe(true);

    const rc = reconcileComponents([]);
    expect(rc.records.some((c) => c.id === GRAPH_NODES_ID)).toBe(true);
    expect(rc.pushes.some((c) => c.id === GRAPH_NODES_ID)).toBe(true);
  });

  it("a DELETED graph-viz re-adds on the next reconcile while user records are untouched (shadow-proof)", () => {
    const userKit: Kit = { id: "my-kit", name: "My Kit", stack: "custom", dot: "var(--accent)" };
    const rk = reconcileKits([userKit]);
    expect(rk.records.find((k) => k.id === "my-kit")).toBe(userKit);
    expect(rk.records.some((k) => k.id === GRAPH_VIZ_KIT_ID)).toBe(true);
    expect(rk.pushes.some((k) => k.id === GRAPH_VIZ_KIT_ID)).toBe(true);
    expect(rk.drops).not.toContain("my-kit");
  });

  it("a PRISTINE graph-viz already in the store stays — kept as current, not re-pushed or dropped", () => {
    const rk = reconcileKits([graphKit]);
    expect(rk.records.find((k) => k.id === GRAPH_VIZ_KIT_ID)).toEqual(graphKit);
    expect(rk.pushes.some((k) => k.id === GRAPH_VIZ_KIT_ID)).toBe(false);
    expect(rk.drops).not.toContain(GRAPH_VIZ_KIT_ID);

    const rc = reconcileComponents([graphComp]);
    expect(rc.records.find((c) => c.id === GRAPH_NODES_ID)).toEqual(graphComp);
    expect(rc.pushes.some((c) => c.id === GRAPH_NODES_ID)).toBe(false);
    expect(rc.drops).not.toContain(GRAPH_NODES_ID);
  });
});
