import { describe, it, expect } from "vitest";
import { expandedPreviewFit } from "./expandedPreviewFit";

describe("expandedPreviewFit (#3551)", () => {
  it("fills the whole canvas at scale 1 in fluid (auto) mode — width-first, no host downscale", () => {
    const f = expandedPreviewFit("auto", 1000, 600);
    expect(f.previewW).toBe(1000); // frame width == canvas width → fills width
    expect(f.previewH).toBe(600);
    expect(f.scale).toBe(1); // NOT downscaled → the in-iframe pan stays 1:1 with the cursor
    expect(f.tx).toBe(0);
    expect(f.ty).toBe(0);
  });

  it("GROWS with the canvas in fluid mode (resizing the panel enlarges the preview)", () => {
    const small = expandedPreviewFit("auto", 800, 500);
    const big = expandedPreviewFit("auto", 1600, 900);
    expect(big.previewW).toBeGreaterThan(small.previewW);
    expect(big.previewH).toBeGreaterThan(small.previewH);
    expect(big.scale).toBe(1); // still fills at 1:1, never pinned to a fixed 1200×440
  });

  it("renders sm/md at their fixed CSS width using the canvas height, downscale-only", () => {
    const sm = expandedPreviewFit("sm", 1000, 600);
    expect(sm.previewW).toBe(380);
    expect(sm.previewH).toBe(600); // canvas height, not a short fixed 440
    // 380 wide easily fits 1000; the height (600 − 48 pad) / 600 ≈ 0.92 bounds it — still ≤ 1 (crisp).
    expect(sm.scale).toBeCloseTo(552 / 600, 5);
    expect(sm.scale).toBeLessThanOrEqual(1);
    expect(sm.tx).toBeGreaterThan(0); // centered horizontally in the wider canvas
  });

  it("never UPSCALES a fixed breakpoint (scale capped at 1) — crispness is preserved", () => {
    // A tiny canvas relative to the 640 md width: width bounds it, still ≤ 1.
    const md = expandedPreviewFit("md", 400, 300);
    expect(md.previewW).toBe(640);
    expect(md.scale).toBeLessThanOrEqual(1);
    expect(md.scale).toBeCloseTo((400 - 48) / 640, 5);
  });

  it("degrades safely before the canvas is measured (0×0 → identity, no NaN)", () => {
    const f = expandedPreviewFit("auto", 0, 0);
    expect(f.scale).toBe(1);
    expect(f.tx).toBe(0);
    expect(f.ty).toBe(0);
    expect(Number.isFinite(f.previewW)).toBe(true);
    expect(Number.isFinite(f.previewH)).toBe(true);
  });
});
