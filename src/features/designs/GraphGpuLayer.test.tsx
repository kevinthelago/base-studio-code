// The two pure seams of the GPU node layer. Everything else in that component needs a real WebGL2
// context and lives in `e2e/`; these two do not, and they are where a silent mismatch would live.
import { describe, it, expect } from "vitest";
import { parseWorldTransform, findWorldLayer } from "@/features/designs/GraphGpuLayer";

describe("parseWorldTransform", () => {
  it("reads the exact string the imperative pan writes", () => {
    // #4140 writes this inline, and `worldTransform` produces the same string for the committed paint,
    // so this is the one format that matters.
    expect(parseWorldTransform("translate(12px, -34px) scale(1.5)")).toEqual({ tx: 12, ty: -34, scale: 1.5 });
  });

  it("tolerates the spacing variations a browser may serialize", () => {
    expect(parseWorldTransform("translate(0px,0px) scale(1)")).toEqual({ tx: 0, ty: 0, scale: 1 });
    expect(parseWorldTransform("translate( 5px , 6px ) scale( 2 )")).toEqual({ tx: 5, ty: 6, scale: 2 });
  });

  it("defaults the missing half rather than returning null", () => {
    // A transform with only a translate is a legitimate un-zoomed view. Returning null there would
    // freeze the canvas at its last view while the DOM panned — the exact desync this parser exists to
    // prevent, and it would look like a rendering bug.
    expect(parseWorldTransform("translate(3px, 4px)")).toEqual({ tx: 3, ty: 4, scale: 1 });
    expect(parseWorldTransform("scale(3)")).toEqual({ tx: 0, ty: 0, scale: 3 });
  });

  it("returns null for no transform at all, so the caller keeps its last view", () => {
    expect(parseWorldTransform("")).toBeNull();
    expect(parseWorldTransform("none")).toBeNull();
  });

  it("handles negative and fractional values", () => {
    expect(parseWorldTransform("translate(-0.5px, -1.25px) scale(0.28)")).toEqual({ tx: -0.5, ty: -1.25, scale: 0.28 });
  });
});

describe("findWorldLayer", () => {
  const mk = (): { vp: HTMLDivElement; canvas: HTMLCanvasElement; world: HTMLDivElement } => {
    const vp = document.createElement("div");
    const grid = document.createElement("div"); // GraphCanvas's static grid — no transform
    const world = document.createElement("div");
    world.style.transform = "translate(1px, 2px) scale(1)";
    const canvas = document.createElement("canvas");
    vp.append(grid, world, canvas);
    return { vp, canvas, world };
  };

  it("finds the sibling carrying the inline transform, past the grid", () => {
    const { canvas, world } = mk();
    expect(findWorldLayer(canvas)).toBe(world);
  });

  it("never returns the canvas itself", () => {
    // The canvas is absolutely positioned and could acquire a transform of its own; picking it would
    // make the view read back its own output and freeze.
    const { canvas } = mk();
    canvas.style.transform = "translate(9px, 9px)";
    expect(findWorldLayer(canvas)).not.toBe(canvas);
  });

  it("returns null when there is no world layer, rather than guessing a sibling", () => {
    const vp = document.createElement("div");
    const canvas = document.createElement("canvas");
    vp.append(document.createElement("div"), canvas);
    expect(findWorldLayer(canvas)).toBeNull();
  });

  it("returns null for an unmounted canvas", () => {
    expect(findWorldLayer(document.createElement("canvas"))).toBeNull();
    expect(findWorldLayer(null)).toBeNull();
  });
});
