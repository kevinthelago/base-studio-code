// #3194 — the `algo-viz` builtin kit: seeded, stamped, and RECOVERABLE (shadow-proof) via the #2483
// reconcile. These guards are flag-INDEPENDENT (algo-viz seeds regardless of DEFAULT_KIT_SEEDED), so they
// run in every configuration — unlike the react-ui seed-refresh block, which is gated on the flag (#3029).
import { describe, it, expect } from "vitest";
import type { Kit } from "./model";
import { SEED_KITS, SEED_COMPONENTS, reconcileKits, reconcileComponents } from "./seed";
import { makeAlgoVizKit, ALGO_CELLS_ID } from "./algoVizKit";
import { seedHashOf } from "./seedRefresh";
import { looksBuildableModule } from "./componentPreview";
import { ALGO_VIZ_KIT_ID, ALGO_VIZ_ANIMATIONS } from "@/shared/ui/kit/algoVizAnimations";

const ANIM_NAMES = ALGO_VIZ_ANIMATIONS.map((a) => a.name); // ["compare","swap","set","sorted"]
const algoKit = SEED_KITS.find((k) => k.id === ALGO_VIZ_KIT_ID)!;
const algoComp = SEED_COMPONENTS.find((c) => c.id === ALGO_CELLS_ID)!;

describe("the algo-viz builtin kit is seeded + stamped (#3194)", () => {
  it("the kit is a seeded builtin with a self-consistent seedHash, carrying the four animations (reused, not duplicated)", () => {
    expect(algoKit).toBeDefined();
    expect(algoKit.builtin).toBe(true);
    expect(algoKit.seedHash).toBe(seedHashOf(algoKit));
    expect(algoKit.animations?.map((a) => a.name)).toEqual(ANIM_NAMES);
    // The kit reuses the SHARED animation DATA by reference — one definition, two consumers (the renderer
    // + this kit); a copy here would silently drift from the ArrayView renderer.
    expect(algoKit.animations).toBe(ALGO_VIZ_ANIMATIONS);
  });

  it("the demo component is a seeded builtin bound to the four animation names, with a buildable preview source", () => {
    expect(algoComp).toBeDefined();
    expect(algoComp.builtin).toBe(true);
    expect(algoComp.kitId).toBe(ALGO_VIZ_KIT_ID);
    expect(algoComp.seedHash).toBe(seedHashOf(algoComp));
    // The four kit animations are bound BY NAME → they surface as the component's motion presets AND mark
    // the kit shelf in the AnimationsMenu.
    expect(algoComp.animations).toEqual(ANIM_NAMES);
    // Its self-contained srcText builds in the sandboxed preview (no `@/` imports, has an export).
    expect(looksBuildableModule(algoComp.srcText)).toBe(true);
  });

  it("makeAlgoVizKit is deterministic (stable seedHash across assemblies — no spurious re-seed)", () => {
    const a = makeAlgoVizKit();
    const b = makeAlgoVizKit();
    expect(a.kits[0].seedHash).toBe(b.kits[0].seedHash);
    expect(a.components[0].seedHash).toBe(b.components[0].seedHash);
    expect(a.kits[0].seedHash).toBe(algoKit.seedHash);
  });
});

describe("recover / shadow-proof: a store lacking algo-viz re-adds it (#3194 via #2483)", () => {
  it("an EMPTY store gets the kit + component appended AND pushed through the bridge", () => {
    const rk = reconcileKits([]);
    expect(rk.records.some((k) => k.id === ALGO_VIZ_KIT_ID)).toBe(true);
    expect(rk.pushes.some((k) => k.id === ALGO_VIZ_KIT_ID)).toBe(true); // converges the global store

    const rc = reconcileComponents([]);
    expect(rc.records.some((c) => c.id === ALGO_CELLS_ID)).toBe(true);
    expect(rc.pushes.some((c) => c.id === ALGO_CELLS_ID)).toBe(true);
  });

  it("a DELETED algo-viz re-adds on the next reconcile while user records are untouched (shadow-proof)", () => {
    // The user deleted algo-viz, so it's absent from the loaded set (only a user kit remains).
    const userKit: Kit = { id: "my-kit", name: "My Kit", stack: "custom", dot: "var(--accent)" };
    const rk = reconcileKits([userKit]);
    expect(rk.records.find((k) => k.id === "my-kit")).toBe(userKit); // user record preserved
    expect(rk.records.some((k) => k.id === ALGO_VIZ_KIT_ID)).toBe(true); // algo-viz re-added
    expect(rk.pushes.some((k) => k.id === ALGO_VIZ_KIT_ID)).toBe(true);
    expect(rk.drops).not.toContain("my-kit");
  });

  it("a PRISTINE algo-viz already in the store stays — kept as current, not re-pushed or dropped", () => {
    const rk = reconcileKits([algoKit]);
    expect(rk.records.find((k) => k.id === ALGO_VIZ_KIT_ID)).toEqual(algoKit);
    expect(rk.pushes.some((k) => k.id === ALGO_VIZ_KIT_ID)).toBe(false);
    expect(rk.drops).not.toContain(ALGO_VIZ_KIT_ID);

    const rc = reconcileComponents([algoComp]);
    expect(rc.records.find((c) => c.id === ALGO_CELLS_ID)).toEqual(algoComp);
    expect(rc.pushes.some((c) => c.id === ALGO_CELLS_ID)).toBe(false);
    expect(rc.drops).not.toContain(ALGO_CELLS_ID);
  });
});
