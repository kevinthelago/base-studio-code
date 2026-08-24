/**
 * @vitest-environment jsdom
 *
 * Under `shared/lib/**` the project environment is `node` — that dir is defined as pure, React-free
 * domain logic. This module is the exception the convention anticipates: its whole job is to ask a
 * live DOM what a colour is, so it needs `HTMLCanvasElement` and `getComputedStyle` to exist even
 * when both are stubs.
 */
// Unit cover for `cssColor` (`graph-colours-fall-back-because-the-tokens-are-oklch`).
//
// WHAT THIS DELIBERATELY DOES NOT TEST: that `var(--info)` resolves. jsdom has no cascade and no
// oklch, so a test here would prove only that the stub returned what the stub was told to return —
// which is how the original defect stayed green through an entire suite. The real claim is asserted
// against a real engine in `e2e/cssColor.spec.ts`, including a mutation check that the old rgb-only
// resolver turns it red. What is left for this level is the machinery an engine will not easily
// produce on demand: a refused assignment, a missing 2D context, and the packed byte order.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveCssColor,
  cssColorToRgba,
  cssColorToPacked,
  resetSwatchForTests,
} from "./cssColor";

/** A probe that records what was assigned; `getComputedStyle` is stubbed per test. */
function fakeProbe() {
  return { style: { color: "" } } as unknown as HTMLElement;
}

function stubComputed(color: string) {
  return vi.spyOn(window, "getComputedStyle").mockReturnValue({ color } as CSSStyleDeclaration);
}

/** A 2D context stand-in whose `fillStyle` setter mimics the real "invalid is ignored" rule. */
function fakeCtx(opts: { accepts?: (v: string) => boolean; bytes?: number[] } = {}) {
  const accepts = opts.accepts ?? (() => true);
  let fill = "#000000";
  const ctx = {
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: string) {
      if (accepts(v)) fill = v;
    },
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => ({ data: Uint8ClampedArray.from(opts.bytes ?? [1, 2, 3, 255]) }),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

function installCtx(ctx: CanvasRenderingContext2D | null) {
  resetSwatchForTests();
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as RenderingContext);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetSwatchForTests();
});

describe("resolveCssColor", () => {
  it("reads the pixel back rather than parsing the string", () => {
    installCtx(fakeCtx({ bytes: [91, 176, 215, 255] }));
    stubComputed("oklch(0.72 0.1 230)");
    // The string is one the old regex could not match; the result is a real colour anyway.
    expect(resolveCssColor("var(--info)", fakeProbe())).toEqual([91, 176, 215, 255]);
  });

  it("returns null when the colour is refused, so the caller's fallback is used", () => {
    // Mimics the engine: an unparseable value leaves `fillStyle` at its previous value, which is why
    // one sentinel cannot detect it and two can.
    installCtx(fakeCtx({ accepts: (v) => v !== "nonsense" }));
    stubComputed("nonsense");
    const probe = fakeProbe();
    expect(resolveCssColor("var(--nope)", probe)).toBeNull();
    expect(cssColorToRgba("var(--nope)", probe, [0.5, 0.5, 0.5, 1])).toEqual([0.5, 0.5, 0.5, 1]);
    expect(cssColorToPacked("var(--nope)", probe, 0xffcccccc)).toBe(0xffcccccc);
  });

  it("falls back to the rgb parser when the environment has no 2D context", () => {
    installCtx(null);
    stubComputed("rgb(10, 20, 30)");
    expect(resolveCssColor("x", fakeProbe())).toEqual([10, 20, 30, 255]);
  });

  it("keeps alpha from an rgba() string on the no-canvas path", () => {
    installCtx(null);
    stubComputed("rgba(10, 20, 30, 0.5)");
    expect(resolveCssColor("x", fakeProbe())).toEqual([10, 20, 30, 128]);
  });

  it("gives up on the no-canvas path rather than mis-parsing a colour space it cannot read", () => {
    installCtx(null);
    stubComputed("oklch(0.72 0.1 230)");
    // Returning a WRONG colour here would be worse than the fallback: the fallback is visibly grey and
    // gets reported, a plausible-but-wrong colour does not.
    expect(resolveCssColor("var(--info)", fakeProbe())).toBeNull();
  });

  it("survives a throwing getComputedStyle", () => {
    installCtx(fakeCtx());
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
      throw new Error("detached");
    });
    expect(resolveCssColor("x", fakeProbe())).toBeNull();
  });

  it("survives a throwing getImageData by falling back to the string", () => {
    const ctx = fakeCtx();
    (ctx as unknown as { getImageData: () => never }).getImageData = () => {
      throw new Error("tainted");
    };
    installCtx(ctx);
    stubComputed("rgb(4, 5, 6)");
    expect(resolveCssColor("x", fakeProbe())).toEqual([4, 5, 6, 255]);
  });

  it("creates the swatch context once, not once per colour", () => {
    const spy = installCtx(fakeCtx());
    stubComputed("rgb(1, 2, 3)");
    const probe = fakeProbe();
    for (let i = 0; i < 5; i++) resolveCssColor("x", probe);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("packing", () => {
  it("packs 0xAABBGGRR — asserted with channels no rotation can disguise", () => {
    installCtx(fakeCtx({ bytes: [255, 128, 0, 255] }));
    stubComputed("rgb(255, 128, 0)");
    expect(cssColorToPacked("x", fakeProbe(), 0)).toBe(0xff0080ff);
  });

  it("scales to 0..1 for the palette uniforms", () => {
    installCtx(fakeCtx({ bytes: [255, 0, 51, 255] }));
    stubComputed("rgb(255, 0, 51)");
    expect(cssColorToRgba("x", fakeProbe(), [])).toEqual([1, 0, 0.2, 1]);
  });
});
