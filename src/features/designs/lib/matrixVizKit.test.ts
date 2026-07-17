// #3242 — the `matrix-viz` builtin kit: seeded, stamped, and RECOVERABLE (shadow-proof) via the #2483
// reconcile. Flag-INDEPENDENT (matrix-viz seeds regardless of DEFAULT_KIT_SEEDED). Mirrors the algo-viz
// guards (#3194).
import { describe, it, expect } from "vitest";
import type { Kit } from "./model";
import { SEED_KITS, SEED_COMPONENTS, reconcileKits, reconcileComponents } from "./seed";
import { makeMatrixVizKit, MATRIX_CELLS_ID } from "./matrixVizKit";
import { seedHashOf } from "./seedRefresh";
import { looksBuildableModule } from "./componentPreview";
import { MATRIX_VIZ_KIT_ID, MATRIX_VIZ_ANIMATIONS } from "@/shared/ui/kit/matrixVizAnimations";

const ANIM_NAMES = MATRIX_VIZ_ANIMATIONS.map((a) => a.name); // ["read","write","region"]
const matrixKit = SEED_KITS.find((k) => k.id === MATRIX_VIZ_KIT_ID)!;
const matrixComp = SEED_COMPONENTS.find((c) => c.id === MATRIX_CELLS_ID)!;

describe("the matrix-viz builtin kit is seeded + stamped (#3242)", () => {
  it("the kit is a seeded builtin with a self-consistent seedHash, carrying the animations (reused, not duplicated)", () => {
    expect(matrixKit).toBeDefined();
    expect(matrixKit.builtin).toBe(true);
    expect(matrixKit.seedHash).toBe(seedHashOf(matrixKit));
    expect(matrixKit.animations?.map((a) => a.name)).toEqual(ANIM_NAMES);
    // Reuses the SHARED animation DATA by reference — one definition, two consumers (the MatrixView
    // renderer + this kit); a copy would silently drift.
    expect(matrixKit.animations).toBe(MATRIX_VIZ_ANIMATIONS);
  });

  it("the demo component is a seeded builtin bound to the animation names, with a buildable preview source", () => {
    expect(matrixComp).toBeDefined();
    expect(matrixComp.builtin).toBe(true);
    expect(matrixComp.kitId).toBe(MATRIX_VIZ_KIT_ID);
    expect(matrixComp.seedHash).toBe(seedHashOf(matrixComp));
    expect(matrixComp.animations).toEqual(ANIM_NAMES);
    expect(looksBuildableModule(matrixComp.srcText)).toBe(true);
  });

  it("makeMatrixVizKit is deterministic (stable seedHash across assemblies — no spurious re-seed)", () => {
    const a = makeMatrixVizKit();
    const b = makeMatrixVizKit();
    expect(a.kits[0].seedHash).toBe(b.kits[0].seedHash);
    expect(a.components[0].seedHash).toBe(b.components[0].seedHash);
    expect(a.kits[0].seedHash).toBe(matrixKit.seedHash);
  });
});

describe("recover / shadow-proof: a store lacking matrix-viz re-adds it (#3242 via #2483)", () => {
  it("an EMPTY store gets the kit + component appended AND pushed through the bridge", () => {
    const rk = reconcileKits([]);
    expect(rk.records.some((k) => k.id === MATRIX_VIZ_KIT_ID)).toBe(true);
    expect(rk.pushes.some((k) => k.id === MATRIX_VIZ_KIT_ID)).toBe(true);

    const rc = reconcileComponents([]);
    expect(rc.records.some((c) => c.id === MATRIX_CELLS_ID)).toBe(true);
    expect(rc.pushes.some((c) => c.id === MATRIX_CELLS_ID)).toBe(true);
  });

  it("a DELETED matrix-viz re-adds on the next reconcile while user records are untouched (shadow-proof)", () => {
    const userKit: Kit = { id: "my-kit", name: "My Kit", stack: "custom", dot: "var(--accent)" };
    const rk = reconcileKits([userKit]);
    expect(rk.records.find((k) => k.id === "my-kit")).toBe(userKit);
    expect(rk.records.some((k) => k.id === MATRIX_VIZ_KIT_ID)).toBe(true);
    expect(rk.pushes.some((k) => k.id === MATRIX_VIZ_KIT_ID)).toBe(true);
    expect(rk.drops).not.toContain("my-kit");
  });

  it("a PRISTINE matrix-viz already in the store stays — kept as current, not re-pushed or dropped", () => {
    const rk = reconcileKits([matrixKit]);
    expect(rk.records.find((k) => k.id === MATRIX_VIZ_KIT_ID)).toEqual(matrixKit);
    expect(rk.pushes.some((k) => k.id === MATRIX_VIZ_KIT_ID)).toBe(false);
    expect(rk.drops).not.toContain(MATRIX_VIZ_KIT_ID);

    const rc = reconcileComponents([matrixComp]);
    expect(rc.records.find((c) => c.id === MATRIX_CELLS_ID)).toEqual(matrixComp);
    expect(rc.pushes.some((c) => c.id === MATRIX_CELLS_ID)).toBe(false);
    expect(rc.drops).not.toContain(MATRIX_CELLS_ID);
  });
});
