// The array viz kit's motion (#3178/#2942) — the compare/swap/set/sorted animations (+ the search pair
// probe/found, #3220) are KitAnimation DATA compiled by the engine (not hand-written CSS), keyed on the
// exact data-states ArrayView stamps,
// and injected into a dedicated managed <style> that never touches the global animation sheet.
import { describe, it, expect, beforeEach } from "vitest";
import {
  ALGO_VIZ_KIT_ID,
  ALGO_VIZ_ANIMATIONS,
  ALGO_VIZ_ANIM_CLASSES,
  ALGO_VIZ_MOTION_CSS,
  ensureArrayViewMotion,
} from "./arrayViewMotion";

describe("algo-viz kit animations (#3178, data-defined #2942)", () => {
  it("defines each verb as data, a STATE trigger on the data-state selector", () => {
    const byName = Object.fromEntries(ALGO_VIZ_ANIMATIONS.map((a) => [a.name, a]));
    expect(Object.keys(byName).sort()).toEqual(["compare", "found", "probe", "set", "sorted", "swap"]);
    expect(byName.compare.selector).toBe('[data-op="compare"]');
    expect(byName.swap.selector).toBe('[data-op="swap"]');
    expect(byName.set.selector).toBe('[data-op="set"]');
    expect(byName.sorted.selector).toBe('[data-mark="sorted"]');
    // The SEARCH pair (#3220): `probe` is a transient single-cell op, `found` a durable terminal mark —
    // so they key on the two DIFFERENT data-state attributes, and a probed cell can also be the found one.
    expect(byName.probe.selector).toBe('[data-op="probe"]');
    expect(byName.found.selector).toBe('[data-mark="found"]');
    // Every one carries real keyframe data (so the engine emits a @keyframes block).
    for (const a of ALGO_VIZ_ANIMATIONS) expect(Object.keys(a.keyframes).length).toBeGreaterThan(0);
  });

  it("compiles (via the engine) to keyframes + rules on the SAME selectors ArrayView stamps", () => {
    // Keyframes are namespaced by kit, and the applying rules scope the data-state under the kit class.
    expect(ALGO_VIZ_MOTION_CSS).toContain("@keyframes bsc-algo-viz-swap");
    expect(ALGO_VIZ_MOTION_CSS).toContain('.algo-viz-anim-swap [data-op="swap"]');
    expect(ALGO_VIZ_MOTION_CSS).toContain('.algo-viz-anim-compare [data-op="compare"]');
    expect(ALGO_VIZ_MOTION_CSS).toContain('.algo-viz-anim-set [data-op="set"]');
    expect(ALGO_VIZ_MOTION_CSS).toContain('.algo-viz-anim-sorted [data-mark="sorted"]');
    expect(ALGO_VIZ_MOTION_CSS).toContain('.algo-viz-anim-probe [data-op="probe"]');
    expect(ALGO_VIZ_MOTION_CSS).toContain('.algo-viz-anim-found [data-mark="found"]');
    // The engine guards motion behind reduced-motion for free.
    expect(ALGO_VIZ_MOTION_CSS).toContain("@media (prefers-reduced-motion: no-preference)");
    // No stray hand-authored keyframes leaked in — every block is kit-namespaced.
    expect(ALGO_VIZ_MOTION_CSS).not.toMatch(/@keyframes (?!bsc-algo-viz-)/);
  });

  it("derives the applying classes from the data (one per animation, kit-namespaced)", () => {
    const classes = ALGO_VIZ_ANIM_CLASSES.split(" ");
    expect(classes).toEqual([
      "algo-viz-anim-compare",
      "algo-viz-anim-swap",
      "algo-viz-anim-set",
      "algo-viz-anim-probe",
      "algo-viz-anim-found",
      "algo-viz-anim-sorted",
    ]);
    expect(ALGO_VIZ_KIT_ID).toBe("algo-viz");
  });

  describe("ensureArrayViewMotion", () => {
    beforeEach(() => {
      document.getElementById("bsc-algo-viz-animations")?.remove();
    });

    it("injects the compiled CSS into a dedicated managed <style> (not the global sheet)", () => {
      ensureArrayViewMotion(document);
      const el = document.getElementById("bsc-algo-viz-animations");
      expect(el).toBeTruthy();
      expect(el?.tagName).toBe("STYLE");
      expect(el?.textContent).toBe(ALGO_VIZ_MOTION_CSS);
      // It must NOT be the global `bsc-ui-animations` sheet the Designs feature owns.
      expect(el?.id).not.toBe("bsc-ui-animations");
    });

    it("is idempotent — repeated calls keep exactly one style element", () => {
      ensureArrayViewMotion(document);
      ensureArrayViewMotion(document);
      ensureArrayViewMotion(document);
      expect(document.querySelectorAll("#bsc-algo-viz-animations").length).toBe(1);
    });
  });
});
