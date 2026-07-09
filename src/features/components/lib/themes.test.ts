// The kit-theme collection (#2488): the packaged seed stamping, the reuse of the generic #2483
// reconcileSeed over theme records (label-named notices), and the picker ordering.
import { describe, it, expect } from "vitest";
import { KIT_THEMES } from "@/shared/ui/kit";
import { SEED_THEMES, reconcileThemes, orderThemes, type KitThemeRecord } from "./themes";
import { seedHashOf, stampSeedHash } from "./seedRefresh";

describe("SEED_THEMES (#2488)", () => {
  it("stamps every packaged theme with builtin + a self-consistent seedHash, in registry order", () => {
    expect(SEED_THEMES.map((t) => t.id)).toEqual(KIT_THEMES.map((t) => t.id));
    expect(SEED_THEMES[0].id).toBe("default");
    for (const t of SEED_THEMES) {
      expect(t.builtin).toBe(true);
      expect(t.seedHash).toBe(seedHashOf(t)); // the stamp matches the content it covers
    }
  });
});

describe("reconcileThemes — the #2483 refresh reused for themes", () => {
  it("re-seeds every built-in into an empty store", () => {
    const r = reconcileThemes([]);
    expect(r.records).toEqual(SEED_THEMES);
    expect(r.pushes).toEqual(SEED_THEMES);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("refreshes a pristine stale built-in copy and keeps a current one", () => {
    const soft = SEED_THEMES.find((t) => t.id === "nord")!;
    // Yesterday's pristine copy: different vars, self-consistently stamped.
    const stale = stampSeedHash({ ...soft, vars: { "--card-radius": "9px" }, seedHash: undefined });
    const r = reconcileThemes([...SEED_THEMES.filter((t) => t.id !== "nord"), stale]);
    expect(r.records.find((t) => t.id === "nord")).toEqual(soft); // refreshed to the new seed copy
    expect(r.pushes).toEqual([soft]);
    expect(r.notices).toEqual([]);
  });

  it("keeps a designer-EDITED built-in with an updated-upstream notice named by its label", () => {
    const soft = SEED_THEMES.find((t) => t.id === "nord")!;
    // A designer edit: content diverged from the recorded (stale) baseline stamp.
    const edited: KitThemeRecord = { ...soft, vars: { "--card-bg": "black" }, seedHash: "00000000" };
    const r = reconcileThemes([...SEED_THEMES.filter((t) => t.id !== "nord"), edited]);
    expect(r.records.find((t) => t.id === "nord")).toEqual(edited); // store wins
    expect(r.pushes).toEqual([]);
    expect(r.notices).toEqual([
      { kind: "updated-upstream", type: "theme", id: "nord", name: soft.label },
    ]);
  });

  it("passes designer-authored themes through untouched", () => {
    const neon: KitThemeRecord = { id: "neon", label: "Neon", description: "glow", vars: { "--card-bg": "black" } };
    const r = reconcileThemes([...SEED_THEMES, neon]);
    expect(r.records).toContainEqual(neon);
    expect(r.pushes).toEqual([]);
    expect(r.drops).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it("drops a pristine copy of a retired built-in but keeps a customized one (orphaned notice)", () => {
    const pristine = stampSeedHash({ id: "gone", label: "Gone", description: "", vars: {}, builtin: true });
    const r1 = reconcileThemes([...SEED_THEMES, pristine]);
    expect(r1.drops).toEqual(["gone"]);
    const customized: KitThemeRecord = { ...pristine, vars: { "--chip-bg": "red" } }; // stamp now stale
    const r2 = reconcileThemes([...SEED_THEMES, customized]);
    expect(r2.drops).toEqual([]);
    expect(r2.notices).toEqual([{ kind: "orphaned", type: "theme", id: "gone", name: "Gone" }]);
  });
});

describe("orderThemes", () => {
  it("puts the packaged registry order first (default leads) then authored themes by label", () => {
    const zeta: KitThemeRecord = { id: "zeta", label: "Zeta", description: "", vars: {} };
    const alpha: KitThemeRecord = { id: "alpha", label: "Alpha", description: "", vars: {} };
    // A filesystem-order shuffle: authored first, built-ins reversed.
    const shuffled = [zeta, ...[...SEED_THEMES].reverse(), alpha];
    const ordered = orderThemes(shuffled);
    expect(ordered.map((t) => t.id)).toEqual([...KIT_THEMES.map((t) => t.id), "alpha", "zeta"]);
    expect(ordered[0].id).toBe("default");
  });
});
