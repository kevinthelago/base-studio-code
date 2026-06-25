import { describe, it, expect } from "vitest";
import { placeMenu, type BoxRect } from "./menuPlacement";

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 220, height: 300 };
// helper: a trigger box from its top-left + size
const btn = (left: number, top: number, w = 24, h = 21): BoxRect => ({
  left, top, right: left + w, bottom: top + h,
});

describe("placeMenu", () => {
  it("opens below, right-aligned to the trigger, when there's room", () => {
    const p = placeMenu(btn(700, 30), MENU, VIEWPORT);
    expect(p.top).toBe(30 + 21 + 4); // below the trigger + gap
    expect(p.left).toBe(700 + 24 - MENU.width); // menu right edge == trigger right edge
    expect(p.left).toBeGreaterThanOrEqual(8);
  });

  it("clamps to the left margin instead of clipping off the left edge", () => {
    // Trigger near the far left → right-aligned left would be negative.
    const p = placeMenu(btn(20, 30), MENU, VIEWPORT);
    expect(p.left).toBe(8); // pinned to the margin, not 20 + 24 - 220 = -176
  });

  it("clamps to the right margin when the trigger is at the far right", () => {
    const p = placeMenu(btn(995, 30), MENU, VIEWPORT);
    expect(p.left).toBe(VIEWPORT.width - MENU.width - 8); // 772
    expect(p.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - 8);
  });

  it("flips above the trigger when there isn't room below", () => {
    // Trigger near the bottom: little space below, lots above.
    const p = placeMenu(btn(700, 760), MENU, VIEWPORT);
    expect(p.top).toBeLessThan(760); // opened upward
    expect(p.top).toBeGreaterThanOrEqual(8);
  });

  it("caps maxHeight to the available space (menu scrolls)", () => {
    // Short viewport so neither side fits the full 300px menu.
    const p = placeMenu(btn(700, 200), MENU, { width: 1000, height: 360 });
    expect(p.maxHeight).toBeLessThan(MENU.height);
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it("never returns a negative maxHeight", () => {
    const p = placeMenu(btn(700, 0, 24, 800), MENU, { width: 1000, height: 800 });
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it("pins a menu wider than the viewport to the left margin", () => {
    const p = placeMenu(btn(50, 30), { width: 1200, height: 200 }, VIEWPORT);
    expect(p.left).toBe(8);
  });
});
